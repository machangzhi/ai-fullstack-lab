/**
 * 文件作用：带历史记录的多轮流式对话（Week 3 Day 6）。
 *
 * 一次请求做三件事：
 * 1. 归属校验后读取受控历史（条数与字符都设上限）。
 * 2. 先把用户消息落库，再调用模型；这样即使模型失败，用户也能看到自己发过什么。
 * 3. 流结束后写入助手消息、更新会话时间和标题，并记录一条用量日志。
 *
 * 设计取舍：
 * - 客户端中断时不保存助手回复：半截回答进入历史会污染下一轮上下文。
 * - 用量日志失败不影响回复落库：统计是辅助能力，不能反过来破坏主流程。
 * - 会话标题只在仍是默认「新对话」时用首条用户消息生成，之后不再自动改名。
 */

import { Injectable, Logger } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import type { ChatHistoryMessage, PromptTemplateId } from '@ai-lab/ai-core';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import type { ChatTokenUsage } from '../ai/openai-chat.transport';
import { ConversationsService } from './conversations.service';

export const DEFAULT_CONVERSATION_TITLE = '新对话';
const TITLE_MAX_LENGTH = 20;

export type ConversationStreamEvent =
  | { type: 'delta'; content: string }
  | {
      type: 'meta';
      modelId: string;
      model: string;
      template: PromptTemplateId;
      usage: ChatTokenUsage | null;
      conversationId: string;
      title: string;
    };

@Injectable()
export class ConversationChatService {
  private readonly logger = new Logger(ConversationChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly ai: AiService,
  ) {}

  async *streamReply(
    userId: string,
    conversationId: string,
    message: string,
    templateId: PromptTemplateId,
    signal?: AbortSignal,
    profileId?: string,
  ): AsyncGenerator<ConversationStreamEvent> {
    const startedAt = Date.now();
    const conversation = await this.conversations.getOwned(userId, conversationId);
    const history = await this.loadHistory(userId, conversationId);

    // 先落用户消息：即使模型调用失败或用户中断，这一问仍然留在历史里。
    await this.conversations.addMessage(userId, conversationId, { content: message });

    let reply = '';
    let meta: { profileId: string; model: string; usage: ChatTokenUsage | null } | null = null;

    for await (const event of this.ai.streamWithHistory(history, message, templateId, {
      signal,
      profileId,
    })) {
      if (event.type === 'delta') {
        reply += event.content;
        yield event;
        continue;
      }
      meta = { profileId: event.modelId, model: event.model, usage: event.usage };
    }

    if (signal?.aborted) {
      return;
    }

    const title =
      conversation.title === DEFAULT_CONVERSATION_TITLE
        ? message.trim().slice(0, TITLE_MAX_LENGTH) || DEFAULT_CONVERSATION_TITLE
        : conversation.title;

    await this.persistReply(userId, conversationId, reply, meta, {
      title,
      latencyMs: Date.now() - startedAt,
      template: templateId,
    });

    yield {
      type: 'meta',
      modelId: meta?.profileId ?? '',
      model: meta?.model ?? '',
      template: templateId,
      usage: meta?.usage ?? null,
      conversationId,
      title,
    };
  }

  /** 读取历史并映射为模型协议；SYSTEM/TOOL 不进入多轮上下文。 */
  private async loadHistory(userId: string, conversationId: string): Promise<ChatHistoryMessage[]> {
    await this.conversations.getOwned(userId, conversationId);

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        role: { in: [MessageRole.USER, MessageRole.ASSISTANT] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { role: true, content: true },
    });

    return rows.reverse().map((row) => ({
      role: row.role === MessageRole.USER ? 'user' : 'assistant',
      content: row.content,
    }));
  }

  /** 助手消息与会话状态放在同一事务；用量日志单独写，失败只记日志。 */
  private async persistReply(
    userId: string,
    conversationId: string,
    reply: string,
    meta: { model: string; usage: ChatTokenUsage | null } | null,
    extra: { title: string; latencyMs: number; template: PromptTemplateId },
  ): Promise<void> {
    if (!reply.trim()) {
      throw new AppError('模型返回了空回复，本次内容未保存。', 'AI_EMPTY_RESPONSE', 502);
    }

    try {
      await this.prisma.$transaction([
        this.prisma.message.create({
          data: {
            conversationId,
            role: MessageRole.ASSISTANT,
            content: reply,
            tokens: meta?.usage?.totalTokens ?? 0,
          },
        }),
        this.prisma.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date(), title: extra.title },
        }),
      ]);
    } catch (error) {
      this.logger.error(`保存助手回复失败：${(error as Error).message}`);
      throw new AppError('回复已生成，但保存失败，请重试。', 'CHAT_PERSIST_FAILED', 500);
    }

    try {
      await this.prisma.usageLog.create({
        data: {
          userId,
          conversationId,
          model: meta?.model ?? 'unknown',
          template: extra.template,
          promptTokens: meta?.usage?.promptTokens ?? 0,
          completionTokens: meta?.usage?.completionTokens ?? 0,
          totalTokens: meta?.usage?.totalTokens ?? 0,
          latencyMs: extra.latencyMs,
        },
      });
    } catch (error) {
      this.logger.warn(`写入用量日志失败：${(error as Error).message}`);
    }
  }
}
