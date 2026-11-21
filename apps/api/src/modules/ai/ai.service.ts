import {
  CLASSIFY_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  buildConversationMessagesWithMemory,
  buildHistorySummaryMessages,
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
  UnknownModelProfileError,
  type ChatTokenUsage,
  type ChatTransport,
  type ModelCatalog,
  type ToolChatMessage,
  type ToolCompletionResult,
  type ToolDefinition,
} from './openai-chat.transport';
import {
  AiCallTimeoutError,
  AiCircuitOpenError,
  AiConcurrencyLimitError,
} from './reliability/reliability-errors';

/** 模型调用选项：客户端只能提交公开档案 ID，不能提交地址或密钥。 */
export interface AiCallOptions {
  profileId?: string;
  signal?: AbortSignal;
  /** 更早对话的摘要，由会话服务生成并持久化。 */
  memorySummary?: string | null;
}

export interface ChatReply {
  reply: string;
  model: string;
  /** 公开档案 ID，前端据此区分是哪一个可切换模型。 */
  modelId: string;
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

/** 流式事件：delta 用于逐字渲染，meta 在最后一条给出档案、模型、模板和用量。 */
export type ChatStreamServiceEvent =
  | { type: 'delta'; content: string }
  | {
      type: 'meta';
      modelId: string;
      model: string;
      template: PromptTemplateId;
      usage: ChatTokenUsage | null;
    };

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

  /** 模型目录：前端只拿到别名、展示名和能力，拿不到地址与密钥。 */
  listModels(): ModelCatalog {
    try {
      return this.transport.listModels();
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  async chat(
    message: string,
    templateId: PromptTemplateId = 'assistant',
    profileId?: string,
  ): Promise<ChatReply> {
    // 模板负责「system 提示词 + 用户输入包裹」，业务层不再手写角色控制。
    const template = getPromptTemplate(templateId);

    try {
      const result = await this.transport.complete(template.build(message.trim()), { profileId });

      return {
        reply: result.content,
        model: result.model,
        modelId: result.profileId,
        usage: result.usage,
        template: template.id,
      };
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  /** 流式对话：逐段产出文本，最后一段 meta 带档案、模型与用量。 */
  async *streamChat(
    message: string,
    templateId: PromptTemplateId = 'assistant',
    options?: AiCallOptions,
  ): AsyncGenerator<ChatStreamServiceEvent> {
    const template = getPromptTemplate(templateId);
    yield* this.streamMessages(template.build(message.trim()), template.id, options);
  }

  /** 多轮对话：system + 受控历史 + 本次输入，历史由调用方按归属校验后提供。 */
  async *streamWithHistory(
    history: ChatHistoryMessage[],
    message: string,
    templateId: PromptTemplateId = 'assistant',
    options?: AiCallOptions,
  ): AsyncGenerator<ChatStreamServiceEvent> {
    const template = getPromptTemplate(templateId);
    yield* this.streamMessages(
      buildConversationMessagesWithMemory(
        template,
        options?.memorySummary,
        history,
        message.trim(),
      ),
      template.id,
      options,
    );
  }

  /** 工具循环的一轮调用；错误与普通对话走同一套安全映射。 */
  async completeWithTools(
    messages: ToolChatMessage[],
    tools: ToolDefinition[],
    profileId?: string,
  ): Promise<ToolCompletionResult> {
    try {
      return await this.transport.completeWithTools(messages, tools, { profileId });
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  /** 当前档案的上下文窗口与输出预算，供会话服务做裁剪与摘要判断。 */
  getModelLimits(profileId?: string): { contextWindow: number; maxOutputTokens: number } {
    try {
      return this.transport.getModelLimits(profileId);
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  /**
   * 把更早的对话压缩成事实摘要。
   * 这是一次普通非流式调用，但属于内部系统任务：失败由调用方决定是否降级，不能影响主回复。
   */
  async summarizeHistory(
    previousSummary: string | null,
    overflow: ChatHistoryMessage[],
    profileId?: string,
  ): Promise<{ summary: string; model: string; modelId: string; usage: ChatTokenUsage | null }> {
    try {
      const result = await this.transport.complete(
        buildHistorySummaryMessages(previousSummary, overflow),
        { profileId },
      );
      const summary = result.content.trim().slice(0, 1200);
      if (!summary) {
        throw new AppError('历史摘要为空，暂时保留原文裁剪策略。', 'AI_EMPTY_RESPONSE', 502);
      }
      return {
        summary,
        model: result.model,
        modelId: result.profileId,
        usage: result.usage,
      };
    } catch (error) {
      throw this.toAppError(error);
    }
  }

  private async *streamMessages(
    messages: Parameters<ChatTransport['stream']>[0],
    templateId: PromptTemplateId,
    options?: AiCallOptions,
  ): AsyncGenerator<ChatStreamServiceEvent> {
    let sawContent = false;
    let meta: { profileId: string; model: string; usage: ChatTokenUsage | null } | null = null;

    try {
      for await (const event of this.transport.stream(messages, options)) {
        if (event.type === 'delta') {
          sawContent = true;
          yield event;
          continue;
        }
        meta = { profileId: event.profileId, model: event.model, usage: event.usage };
      }
    } catch (error) {
      // 客户端主动断开不算错误：不再写日志、不再向已关闭的连接发送事件。
      if (options?.signal?.aborted) {
        return;
      }
      throw this.toAppError(error);
    }

    if (!sawContent) {
      throw new AppError('模型未返回有效回复，请稍后重试。', 'AI_EMPTY_RESPONSE', 502);
    }

    yield {
      type: 'meta',
      modelId: meta?.profileId ?? '',
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
    if (error instanceof UnknownModelProfileError) {
      return new AppError('所选模型不可用，请刷新模型列表后重试。', 'AI_MODEL_UNKNOWN', 400);
    }
    // 可靠性层错误（Week 4 Day 4）：分别对应超时、并发饱和与熔断打开。
    if (error instanceof AiCallTimeoutError) {
      return new AppError('模型响应超时，请稍后重试。', 'AI_TIMEOUT', 504);
    }
    if (error instanceof AiConcurrencyLimitError) {
      return new AppError('当前模型请求过多，请稍后重试。', 'AI_CONCURRENCY_LIMIT', 503);
    }
    if (error instanceof AiCircuitOpenError) {
      return new AppError('模型服务连续失败，已暂停请求，请稍后重试。', 'AI_CIRCUIT_OPEN', 503);
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
