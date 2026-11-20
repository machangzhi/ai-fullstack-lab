import {
  CLASSIFY_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  buildConversationMessages,
  buildStructuredUserMessage,
  getPromptTemplate,
  parseEntityExtraction,
  parseFeedbackClassification,
  type ChatHistoryMessage,
  type EntityExtraction,
  type FeedbackClassification,
  type PromptTemplateId,
  type StructuredParseResult,
} from '@ai-lab/ai-core';
import { Inject, Injectable } from '@nestjs/common';
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { AppError } from '../../common/errors/app-error';
import {
  CHAT_TRANSPORT,
  ChatConfigurationError,
  EmptyChatResponseError,
  type ChatTokenUsage,
  type ChatTransport,
} from './openai-chat.transport';

export interface ChatReply {
  reply: string;
  model: string;
  usage: ChatTokenUsage | null;
  /** 实际使用的模板，便于前端确认对比结果来自哪个 Prompt。 */
  template: PromptTemplateId;
}

/** 结构化结果：data 已通过 Zod 校验，attempts 反映真实请求次数（重试会增加费用）。 */
export interface StructuredReply<T> {
  data: T;
  model: string;
  usage: ChatTokenUsage | null;
  attempts: number;
}

/** 流式事件：delta 用于逐字渲染，meta 在最后一条给出模型、模板和用量。 */
export type ChatStreamServiceEvent =
  | { type: 'delta'; content: string }
  | { type: 'meta'; model: string; template: PromptTemplateId; usage: ChatTokenUsage | null };

/** 首次请求 + 最多一次修复重试，避免无限循环放大费用。 */
const STRUCTURED_MAX_ATTEMPTS = 2;

function addUsage(
  current: ChatTokenUsage | null,
  next: ChatTokenUsage | null,
): ChatTokenUsage | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  };
}

@Injectable()
export class AiService {
  constructor(@Inject(CHAT_TRANSPORT) private readonly transport: ChatTransport) {}

  async chat(message: string, templateId: PromptTemplateId = 'assistant'): Promise<ChatReply> {
    // 模板负责「system 提示词 + 用户输入包裹」，业务层不再手写角色控制。
    const template = getPromptTemplate(templateId);

    try {
      const result = await this.transport.complete(template.build(message.trim()));

      return {
        reply: result.content,
        model: result.model,
        usage: result.usage,
        template: template.id,
      };
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  /** 流式对话：逐段产出文本，最后一段 meta 带模型与用量。 */
  async *streamChat(
    message: string,
    templateId: PromptTemplateId = 'assistant',
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamServiceEvent> {
    const template = getPromptTemplate(templateId);
    yield* this.streamMessages(template.build(message.trim()), template.id, signal);
  }

  /** 多轮对话：system + 受控历史 + 本次输入，历史由调用方按归属校验后提供。 */
  async *streamWithHistory(
    history: ChatHistoryMessage[],
    message: string,
    templateId: PromptTemplateId = 'assistant',
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamServiceEvent> {
    const template = getPromptTemplate(templateId);
    yield* this.streamMessages(
      buildConversationMessages(template, history, message.trim()),
      template.id,
      signal,
    );
  }

  private async *streamMessages(
    messages: Parameters<ChatTransport['stream']>[0],
    templateId: PromptTemplateId,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamServiceEvent> {
    let sawContent = false;
    let meta: { model: string; usage: ChatTokenUsage | null } | null = null;

    try {
      for await (const event of this.transport.stream(messages, { signal })) {
        if (event.type === 'delta') {
          sawContent = true;
          yield event;
          continue;
        }
        meta = { model: event.model, usage: event.usage };
      }
    } catch (error) {
      // 客户端主动断开不算错误：不再写日志、不再向已关闭的连接发送事件。
      if (signal?.aborted) {
        return;
      }
      throw this.toAppError(error);
    }

    if (!sawContent) {
      throw new AppError('模型未返回有效回复，请稍后重试。', 'AI_EMPTY_RESPONSE', 502);
    }

    yield {
      type: 'meta',
      model: meta?.model ?? '',
      template: templateId,
      usage: meta?.usage ?? null,
    };
  }

  /** 文本分类：模型输出必须通过 Zod schema，失败时带着错误原因重试一次。 */
  classify(text: string): Promise<StructuredReply<FeedbackClassification>> {
    return this.completeStructured(CLASSIFY_SYSTEM_PROMPT, text, parseFeedbackClassification);
  }

  /** 实体抽取：与分类共用同一套解析与重试策略。 */
  extractEntities(text: string): Promise<StructuredReply<EntityExtraction>> {
    return this.completeStructured(EXTRACT_SYSTEM_PROMPT, text, parseEntityExtraction);
  }

  private async completeStructured<T>(
    system: string,
    text: string,
    parse: (raw: string) => StructuredParseResult<T>,
  ): Promise<StructuredReply<T>> {
    const baseUser = buildStructuredUserMessage(text.trim());
    let usage: ChatTokenUsage | null = null;
    let lastFailure = '';

    try {
      for (let attempt = 1; attempt <= STRUCTURED_MAX_ATTEMPTS; attempt += 1) {
        // 重试时把解析失败原因写回用户消息，而不是原样重发——同样的输入只会得到同样的输出。
        const userContent =
          attempt === 1
            ? baseUser
            : `${baseUser}\n\n上一次输出无法解析：${lastFailure}请只输出符合要求的 JSON，不要 Markdown 代码块，不要解释。`;

        const result = await this.transport.complete([
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ]);

        usage = addUsage(usage, result.usage);
        const parsed = parse(result.content);

        if (parsed.success) {
          return { data: parsed.data, model: result.model, usage, attempts: attempt };
        }

        // 只保留稳定的失败描述（空内容 / 非 JSON / 字段不符合），不回显模型原文。
        lastFailure = `${parsed.message} `;
      }
    } catch (error) {
      throw this.toAppError(error);
    }

    throw new AppError('模型输出无法按约定解析，请稍后重试。', 'AI_INVALID_OUTPUT', 502);
  }

  /** 只暴露稳定、安全的错误，不透传供应商响应或连接信息。 */
  private toAppError(error: unknown): AppError {
    if (error instanceof AppError) {
      return error;
    }
    if (error instanceof ChatConfigurationError) {
      return new AppError('模型服务尚未正确配置，请检查服务端环境变量。', 'AI_CONFIG_ERROR', 503);
    }
    if (error instanceof APIConnectionTimeoutError) {
      return new AppError('模型响应超时，请稍后重试。', 'AI_TIMEOUT', 504);
    }
    if (error instanceof APIConnectionError) {
      return new AppError('暂时无法连接模型服务，请稍后重试。', 'AI_UNAVAILABLE', 503);
    }
    if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
      return new AppError('模型服务认证失败，请检查服务端 API Key。', 'AI_PROVIDER_AUTH', 502);
    }
    if (error instanceof APIError && error.status === 429) {
      return new AppError('模型服务请求过于频繁，请稍后重试。', 'RATE_LIMITED', 429);
    }
    if (error instanceof EmptyChatResponseError) {
      return new AppError('模型未返回有效回复，请稍后重试。', 'AI_EMPTY_RESPONSE', 502);
    }
    return new AppError('模型服务暂时不可用，请稍后重试。', 'AI_PROVIDER_ERROR', 502);
  }
}
