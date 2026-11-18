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
}

const SYSTEM_MESSAGE = '你是 AI 应用全栈开发学习助手。请用简洁、准确的中文回答；不确定时明确说明。';

@Injectable()
export class AiService {
  constructor(@Inject(CHAT_TRANSPORT) private readonly transport: ChatTransport) {}

  async chat(message: string): Promise<ChatReply> {
    try {
      const result = await this.transport.complete([
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: message.trim() },
      ]);

      return {
        reply: result.content,
        model: result.model,
        usage: result.usage,
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
