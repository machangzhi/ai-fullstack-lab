import {
  resolveModelProfiles,
  selectModelProfile,
  toPublicModelProfile,
  type ModelProfileConfig,
  type ModelProfileRegistry,
  type ModelProviderEnvironment,
} from '@ai-lab/ai-core';
import { Injectable } from '@nestjs/common';
import {
  ChatConfigurationError,
  OpenAiChatTransport,
  UnknownModelProfileError,
  type ChatPromptMessage,
  type ChatRequestOptions,
  type ChatStreamEvent,
  type ChatStreamOptions,
  type ChatTransport,
  type ChatTransportResult,
  type ModelCatalog,
} from './openai-chat.transport';

/**
 * 统一 LLMService（Week 4 Day 1）。
 *
 * 职责边界：
 * 1. 解析并持有模型档案目录，对外只暴露公开别名。
 * 2. 按别名惰性创建并复用 OpenAI 兼容客户端；业务层不再读取环境变量。
 * 3. 把“未知模型”和“配置缺失”分成两类错误，前者是 400，后者是 503。
 *
 * 为什么按需解析配置：Week 3 的行为是密钥缺失时应用仍能启动、聊天接口才报错。
 * 这里保持同样取舍，避免一个可选的模型档案把健康检查和其他模块一起拖垮。
 */
@Injectable()
export class LlmService implements ChatTransport {
  private registry?: ModelProfileRegistry;
  private readonly clients = new Map<string, ChatTransport>();

  constructor(
    private readonly env: ModelProviderEnvironment = process.env,
    /** 注入点用于测试：默认创建真实 OpenAI 兼容客户端。 */
    private readonly createClient: (profile: ModelProfileConfig) => ChatTransport = (profile) =>
      new OpenAiChatTransport(profile),
  ) {}

  async complete(
    messages: ChatPromptMessage[],
    options?: ChatRequestOptions,
  ): Promise<ChatTransportResult> {
    // async 保证配置错误也以 rejected promise 返回，调用方可以统一 try/catch。
    return this.getClient(options?.profileId).complete(messages);
  }

  async *stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    yield* this.getClient(options?.profileId).stream(messages, { signal: options?.signal });
  }

  listModels(): ModelCatalog {
    const registry = this.getRegistry();
    return {
      defaultId: registry.defaultProfileId,
      models: registry.profiles.map(toPublicModelProfile),
    };
  }

  /** 上下文预算从这里取，确保“前端选的模型”和“裁剪用的窗口”是同一份配置。 */
  getModelLimits(profileId?: string): { contextWindow: number; maxOutputTokens: number } {
    const profile = this.resolveProfile(profileId);
    return {
      contextWindow: profile.capabilities.contextWindow,
      maxOutputTokens: profile.maxTokens,
    };
  }

  /** 解析失败只报告“配置不可用”，不把环境变量内容拼进错误。 */
  private getRegistry(): ModelProfileRegistry {
    if (!this.registry) {
      try {
        this.registry = resolveModelProfiles(this.env);
      } catch {
        throw new ChatConfigurationError();
      }
    }
    return this.registry;
  }

  private getClient(profileId?: string): ChatTransport {
    const profile = this.resolveProfile(profileId);

    const cached = this.clients.get(profile.id);
    if (cached) {
      return cached;
    }

    const client = this.createClient(profile);
    this.clients.set(profile.id, client);
    return client;
  }

  private resolveProfile(profileId?: string): ModelProfileConfig {
    const registry = this.getRegistry();
    try {
      return selectModelProfile(registry, profileId);
    } catch {
      // 目录已解析成功，取不到只可能是客户端传了不存在的别名。
      throw new UnknownModelProfileError();
    }
  }
}
