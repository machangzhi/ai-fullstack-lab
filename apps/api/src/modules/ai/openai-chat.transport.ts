import {
  resolveModelProviderConfig,
  type ModelProviderConfig,
  type ModelProviderEnvironment,
} from '@ai-lab/ai-core';
import OpenAI from 'openai';

export const CHAT_TRANSPORT = Symbol('CHAT_TRANSPORT');

/** 只允许服务端组装 system/user 输入，assistant 是模型输出而非客户端输入。 */
export interface ChatPromptMessage {
  role: 'system' | 'user';
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
}

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
