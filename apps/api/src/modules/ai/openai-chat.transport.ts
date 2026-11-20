import {
  resolveModelProviderConfig,
  type ModelProviderConfig,
  type ModelProviderEnvironment,
} from '@ai-lab/ai-core';
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
  model: string;
  usage: ChatTokenUsage | null;
}

export interface ChatTransport {
  complete(messages: ChatPromptMessage[]): Promise<ChatTransportResult>;
  /** 流式返回增量文本；最后一个事件固定是 meta，携带模型名与用量。 */
  stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncIterable<ChatStreamEvent>;
}

export interface ChatStreamOptions {
  /** 客户端断开连接时由上层取消，避免继续消耗模型额度。 */
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'meta'; model: string; usage: ChatTokenUsage | null };

export class ChatConfigurationError extends Error {
  constructor() {
    super('Model provider is not configured correctly.');
    this.name = 'ChatConfigurationError';
  }
}

export class EmptyChatResponseError extends Error {
  constructor() {
    super('Model provider returned an empty response.');
    this.name = 'EmptyChatResponseError';
  }
}

/**
 * OpenAI 兼容协议传输层。DeepSeek 使用官方 baseURL 与 deepseek-chat，
 * OpenAI SDK 只负责协议、超时和错误分类，不代表请求发往 OpenAI。
 */
export class OpenAiChatTransport implements ChatTransport {
  private config?: ModelProviderConfig;
  private client?: OpenAI;

  constructor(
    private readonly env: ModelProviderEnvironment = process.env,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async complete(messages: ChatPromptMessage[]): Promise<ChatTransportResult> {
    const { config, client } = this.getClient();
    const completion = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    });

    const content = completion.choices[0]?.message.content?.trim();
    if (!content) {
      throw new EmptyChatResponseError();
    }

    const usage = completion.usage;
    return {
      content,
      model: completion.model || config.model,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : null,
    };
  }

  async *stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const { config, client } = this.getClient();
    const completionStream = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: true,
        // 让供应商在流的末尾补一条 usage；部分兼容实现不支持，则降级为 null。
        stream_options: { include_usage: true },
      },
      { signal: options?.signal },
    );

    let model = config.model;
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
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    yield { type: 'meta', model, usage };
  }

  /** 首次调用才解析密钥和创建客户端，不影响健康检查等其他接口启动。 */
  private getClient(): { config: ModelProviderConfig; client: OpenAI } {
    if (this.config && this.client) {
      return { config: this.config, client: this.client };
    }

    let config: ModelProviderConfig;
    try {
      config = resolveModelProviderConfig(this.env);
    } catch {
      throw new ChatConfigurationError();
    }

    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 0,
      fetch: this.fetchImpl,
    });

    this.config = config;
    this.client = client;
    return { config, client };
  }
}
