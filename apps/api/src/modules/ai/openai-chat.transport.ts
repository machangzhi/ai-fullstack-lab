import type { ModelProfileConfig, PublicModelProfile } from '@ai-lab/ai-core';
import OpenAI from 'openai';

export const CHAT_TRANSPORT = Symbol('CHAT_TRANSPORT');

/** 只允许服务端组装 system/user 输入，assistant 是模型输出而非客户端输入。 */
export interface ChatPromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatTransportResult {
  content: string;
  /** 供应商实际返回的模型名，可能与配置别名不同。 */
  model: string;
  /** 本次使用的公开档案 ID，客户端据此显示是哪一个模型回答的。 */
  profileId: string;
  usage: ChatTokenUsage | null;
}

/** 客户端只允许用公开档案 ID 选择模型，不能指定地址、模型名或密钥。 */
export interface ChatRequestOptions {
  profileId?: string;
}

export interface ChatTransport {
  complete(
    messages: ChatPromptMessage[],
    options?: ChatRequestOptions,
  ): Promise<ChatTransportResult>;
  /** 流式返回增量文本；最后一个事件固定是 meta，携带档案、模型名与用量。 */
  stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncIterable<ChatStreamEvent>;
  /** 可供前端切换的模型目录，已做白名单脱敏。 */
  listModels(): ModelCatalog;
}

export interface ChatStreamOptions extends ChatRequestOptions {
  /** 客户端断开连接时由上层取消，避免继续消耗模型额度。 */
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'meta'; profileId: string; model: string; usage: ChatTokenUsage | null };

export interface ModelCatalog {
  defaultId: string;
  models: PublicModelProfile[];
}

export class ChatConfigurationError extends Error {
  constructor() {
    super('Model provider is not configured correctly.');
    this.name = 'ChatConfigurationError';
  }
}

/** 客户端提交了不存在的档案 ID。属于 400，不应重试。 */
export class UnknownModelProfileError extends Error {
  constructor() {
    super('Requested model profile is not available.');
    this.name = 'UnknownModelProfileError';
  }
}

export class EmptyChatResponseError extends Error {
  constructor() {
    super('Model provider returned an empty response.');
    this.name = 'EmptyChatResponseError';
  }
}

/**
 * 单个模型档案的 OpenAI 兼容协议适配器。
 *
 * 与 Week 3 的差异：构造函数接收已经解析好的 ModelProfileConfig，而不是环境变量。
 * 这样一次进程内可以持有多个不同模型（甚至不同供应商）的客户端，
 * 而业务层只依赖 ChatTransport 接口，不需要知道 OpenAI SDK 的存在。
 */
export class OpenAiChatTransport implements ChatTransport {
  private client?: OpenAI;

  constructor(
    private readonly profile: ModelProfileConfig,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async complete(messages: ChatPromptMessage[]): Promise<ChatTransportResult> {
    const completion = await this.getClient().chat.completions.create({
      model: this.profile.model,
      messages,
      temperature: this.profile.temperature,
      max_tokens: this.profile.maxTokens,
      stream: false,
    });

    const content = completion.choices[0]?.message.content?.trim();
    if (!content) {
      throw new EmptyChatResponseError();
    }

    return {
      content,
      model: completion.model || this.profile.model,
      profileId: this.profile.id,
      usage: toTokenUsage(completion.usage),
    };
  }

  async *stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const completionStream = await this.getClient().chat.completions.create(
      {
        model: this.profile.model,
        messages,
        temperature: this.profile.temperature,
        max_tokens: this.profile.maxTokens,
        stream: true,
        // 让供应商在流的末尾补一条 usage；部分兼容实现不支持，则降级为 null。
        stream_options: { include_usage: true },
      },
      { signal: options?.signal },
    );

    let model = this.profile.model;
    let usage: ChatTokenUsage | null = null;

    for await (const chunk of completionStream) {
      if (chunk.model) {
        model = chunk.model;
      }

      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield { type: 'delta', content };
      }

      if (chunk.usage) {
        usage = toTokenUsage(chunk.usage);
      }
    }

    yield { type: 'meta', profileId: this.profile.id, model, usage };
  }

  /** 单档案适配器没有完整目录，目录由 LlmService 提供。 */
  listModels(): ModelCatalog {
    return {
      defaultId: this.profile.id,
      models: [
        {
          id: this.profile.id,
          label: this.profile.label,
          provider: this.profile.provider,
          model: this.profile.model,
          temperature: this.profile.temperature,
          maxTokens: this.profile.maxTokens,
          capabilities: this.profile.capabilities,
        },
      ],
    };
  }

  /** 客户端在首次调用时才创建，避免启动阶段因模型配置缺失而整体失败。 */
  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.profile.apiKey,
        baseURL: this.profile.baseUrl,
        timeout: this.profile.timeoutMs,
        maxRetries: 0,
        fetch: this.fetchImpl,
      });
    }
    return this.client;
  }
}

function toTokenUsage(
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined,
): ChatTokenUsage | null {
  return usage
    ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      }
    : null;
}
