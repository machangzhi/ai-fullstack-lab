import { getPromptTemplate, type PromptTemplateId } from '@ai-lab/ai-core';
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
