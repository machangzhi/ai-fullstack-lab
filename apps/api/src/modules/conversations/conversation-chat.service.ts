/**
 * 文件作用：带历史记录的多轮流式对话（Week 3 Day 6，Week 4 Day 2 加入摘要记忆）。
 *
 * 一次请求做五件事：
 * 1. 归属校验后读取摘要游标与游标之后的原始消息。
 * 2. 按模型上下文窗口规划 recent / overflow：recent 原样回放，overflow 进入摘要。
 * 3. 先把用户消息落库，再调用模型；即使模型失败，用户也能看到自己发过什么。
 * 4. 溢出达到阈值时增量更新摘要；摘要失败只降级为原文裁剪，不阻断聊天。
 * 5. 流结束后写入助手消息、更新会话时间和标题，并记录一条用量日志。
 *
 * 设计取舍：
 * - 摘要持久化在 conversations 表，避免每轮重复压缩同一批历史。
 * - summarizedMessages 是「已覆盖的最早 N 条」游标，消息只追加不删除，因此计数稳定。
 * - 每次最多摘要 20 条，剩余溢出留到后续轮次，避免一次内部调用无上限增长。
 * - 客户端中断时不保存助手回复：半截回答进入历史会污染下一轮上下文。
 */

import {
  MEMORY_RESERVE_TOKENS,
  estimateMessagesTokens,
  planContext,
  type ChatHistoryMessage,
  type PromptTemplateId,
} from '@ai-lab/ai-core';
import { Injectable, Logger } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService, type AiCallOptions } from '../ai/ai.service';
import type { ChatTokenUsage } from '../ai/openai-chat.transport';
import { ConversationsService } from './conversations.service';

export const DEFAULT_CONVERSATION_TITLE = '新对话';
const TITLE_MAX_LENGTH = 20;
/** 一次最多加载多少条原始历史；更早的内容必须已经被摘要覆盖。 */
const MAX_CONTEXT_HISTORY_MESSAGES = 60;
/** 溢出少于这个条数且 Token 很少时先不摘要，避免每轮多一次模型调用。 */
const MIN_SUMMARY_MESSAGES = 4;
const MIN_SUMMARY_TOKENS = 800;
/** 单次摘要最多处理的早期消息数，剩余留到后续轮次。 */
const MAX_SUMMARY_MESSAGES_PER_RUN = 20;

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

interface ConversationMemory {
  summary: string | null;
  summarizedMessages: number;
}

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
    const memory = await this.loadMemory(userId, conversationId);
    const history = await this.loadHistory(conversationId, memory.summarizedMessages);

    // 预算来自「本次实际选择的模型档案」，而不是写死一个常量。
    const limits = this.ai.getModelLimits(profileId);
    let plan = planContext(history, message, limits);

    // 摘要本身也占输入 Token：存在旧摘要或本轮将生成摘要时，为它预留固定预算。
    const willSummarize = this.shouldSummarize(plan.overflow);
    if (memory.summary || willSummarize) {
      plan = planContext(history, message, limits, {
        reservedTokens: MEMORY_RESERVE_TOKENS,
      });
    }

    // 先落用户消息：即使模型调用失败或用户中断，这一问仍然留在历史里。
    await this.conversations.addMessage(userId, conversationId, { content: message });

    const summary = await this.updateMemory(
      userId,
      conversationId,
      memory.summary,
      plan.overflow,
      profileId,
    );

    let reply = '';
    let meta: { profileId: string; model: string; usage: ChatTokenUsage | null } | null = null;

    const options: AiCallOptions = { signal, profileId, memorySummary: summary };
    for await (const event of this.ai.streamWithHistory(
      plan.recent,
      message,
      templateId,
      options,
    )) {
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

  /** 只读取摘要与游标，不把摘要返回给前端。 */
  private async loadMemory(userId: string, conversationId: string): Promise<ConversationMemory> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { historySummary: true, summarizedMessages: true },
    });

    return {
      summary: row?.historySummary ?? null,
      summarizedMessages: row?.summarizedMessages ?? 0,
    };
  }

  /** 摘要是缓慢推进的：每次只处理游标之后、且本轮被挤出窗口的最早一批消息。 */
  private async updateMemory(
    userId: string,
    conversationId: string,
    previousSummary: string | null,
    overflow: ChatHistoryMessage[],
    profileId?: string,
  ): Promise<string | null> {
    if (!this.shouldSummarize(overflow)) {
      return previousSummary;
    }

    const batch = overflow.slice(0, MAX_SUMMARY_MESSAGES_PER_RUN);
    const startedAt = Date.now();

    try {
      const result = await this.ai.summarizeHistory(previousSummary, batch, profileId);

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          historySummary: result.summary,
          summarizedMessages: { increment: batch.length },
        },
      });

      await this.recordMemoryUsage(userId, conversationId, {
        model: result.model,
        usage: result.usage,
        latencyMs: Date.now() - startedAt,
      });

      return result.summary;
    } catch (error) {
      // 摘要失败不能影响主回复：本轮退化为「只用 recent 原文」。
      this.logger.warn(`历史摘要失败，已降级为原文裁剪：${(error as Error).message}`);
      return previousSummary;
    }
  }

  private shouldSummarize(overflow: ChatHistoryMessage[]): boolean {
    if (overflow.length === 0) {
      return false;
    }
    return (
      overflow.length >= MIN_SUMMARY_MESSAGES ||
      estimateMessagesTokens(overflow) >= MIN_SUMMARY_TOKENS
    );
  }

  /** 读取游标之后的原文；游标之前的内容已经由摘要代表。 */
  private async loadHistory(
    conversationId: string,
    summarizedMessages: number,
  ): Promise<ChatHistoryMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        role: { in: [MessageRole.USER, MessageRole.ASSISTANT] },
      },
      orderBy: { createdAt: 'asc' },
      skip: summarizedMessages,
      take: MAX_CONTEXT_HISTORY_MESSAGES,
      select: { role: true, content: true },
    });

    return rows.map((row) => ({
      role: row.role === MessageRole.USER ? 'user' : 'assistant',
      content: row.content,
    }));
  }

  private async recordMemoryUsage(
    userId: string,
    conversationId: string,
    meta: { model: string; usage: ChatTokenUsage | null; latencyMs: number },
  ): Promise<void> {
    try {
      await this.prisma.usageLog.create({
        data: {
          userId,
          conversationId,
          model: meta.model,
          template: 'memory-summary',
          promptTokens: meta.usage?.promptTokens ?? 0,
          completionTokens: meta.usage?.completionTokens ?? 0,
          totalTokens: meta.usage?.totalTokens ?? 0,
          latencyMs: meta.latencyMs,
        },
      });
    } catch (error) {
      this.logger.warn(`写入摘要用量失败：${(error as Error).message}`);
    }
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
