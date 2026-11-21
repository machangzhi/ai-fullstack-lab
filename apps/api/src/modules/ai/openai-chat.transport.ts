import {
  toPublicModelProfile,
  type ModelProfileConfig,
  type PublicModelProfile,
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

/** 暴露给模型的工具描述；parameters 必须是合法的 JSON Schema。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 模型请求调用某个工具；arguments 是原始 JSON 字符串，必须由服务端校验。 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** 工具调用往返中的消息，只允许服务端构造。 */
export type ToolChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolCompletionResult {
  content: string | null;
  toolCalls: ToolCallRequest[];
  model: string;
  profileId: string;
  usage: ChatTokenUsage | null;
  finishReason: string | null;
}

export interface ChatTransport {
  complete(
    messages: ChatPromptMessage[],
    options?: ChatRequestOptions,
  ): Promise<ChatTransportResult>;
  /** Function Calling 的一轮模型调用：可能返回文本，也可能返回工具调用请求。 */
  completeWithTools(
    messages: ToolChatMessage[],
    tools: ToolDefinition[],
    options?: ChatRequestOptions,
  ): Promise<ToolCompletionResult>;
  /** 流式返回增量文本；最后一个事件固定是 meta，携带档案、模型名与用量。 */
  stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncIterable<ChatStreamEvent>;
  /** 可供前端切换的模型目录，已做白名单脱敏。 */
  listModels(): ModelCatalog;
  /** 当前档案的上下文窗口与输出预算，供上层做历史裁剪。 */
  getModelLimits(profileId?: string): { contextWindow: number; maxOutputTokens: number };
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

  async completeWithTools(
    messages: ToolChatMessage[],
    tools: ToolDefinition[],
  ): Promise<ToolCompletionResult> {
    const completion = await this.getClient().chat.completions.create({
      model: this.profile.model,
      messages: toOpenAiMessages(messages),
      tools: tools.map(toOpenAiTool),
      // auto 让模型自己决定是否调用工具；本项目的工具都是只读/无副作用，暂不限制。
      tool_choice: 'auto',
      temperature: this.profile.temperature,
      max_tokens: this.profile.maxTokens,
      stream: false,
    });

    const choice = completion.choices[0];
    // 部分兼容实现会返回空数组而不是省略字段，统一过滤掉非 function 调用。
    const toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));

    return {
      content: choice?.message?.content ?? null,
      toolCalls,
      model: completion.model || this.profile.model,
      profileId: this.profile.id,
      usage: toTokenUsage(completion.usage),
      finishReason: choice?.finish_reason ?? null,
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
      models: [toPublicModelProfile(this.profile)],
    };
  }

  getModelLimits(): { contextWindow: number; maxOutputTokens: number } {
    return {
      contextWindow: this.profile.capabilities.contextWindow,
      maxOutputTokens: this.profile.maxTokens,
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

/** 内部消息 → OpenAI 消息。工具结果必须带 tool_call_id，模型才能把结果对上请求。 */
function toOpenAiMessages(messages: ToolChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }

    if (message.role === 'assistant') {
      if (message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
      return { role: 'assistant', content: message.content ?? '' };
    }

    return { role: message.role, content: message.content };
  });
}

/** 工具 Schema 原样交给模型；真正的参数校验仍在服务端执行前完成。 */
function toOpenAiTool(tool: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  } as OpenAI.Chat.ChatCompletionTool;
}
