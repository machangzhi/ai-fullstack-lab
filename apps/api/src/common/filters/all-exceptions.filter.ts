/**
 * 文件作用：全局异常过滤器 AllExceptionsFilter。
 *
 * 关键概念：
 * 1. NestJS 异常过滤器（ExceptionFilter）—— 捕获控制器/服务中抛出的异常，
 *    转换成统一的 HTTP 响应。@Catch() 不传参数表示捕获所有异常。
 * 2. 为什么需要它？—— 默认情况下 NestJS 对未处理异常返回 500 + 简单 HTML，
 *    前端拿到非 JSON 结构很难处理。这里统一转成 { success:false, error:{...} }。
 * 3. normalize() 方法—— 把各种异常（AppError / HttpException / 未知异常）
 *    归一化成 { status, code, message, details }，方便统一输出。
 * 4. 5xx 错误写日志堆栈—— 服务端内部错误需要排查，把堆栈打出来；4xx 是客户端问题，不打堆栈。
 * 5. request.requestId 用于错误日志追踪，和成功响应的 requestId 对应。
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../errors/app-error';
import { codeForStatus } from '../errors/error-codes';

// 归一化后的错误结构，供 catch 方法统一输出。
interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 统一失败响应结构：{ success, error: { code, message, details }, requestId, timestamp }
 */
// @Catch() 无参数 = 捕获所有类型的异常。
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // 用类名作为 Logger 上下文，日志中会显示 [AllExceptionsFilter] 前缀。
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // 切换到 HTTP 上下文，拿到原生 Request 和 Response。
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 把各种异常归一化成统一结构。
    const { status, code, message, details } = this.normalize(exception);

    // 5xx（服务端错误）记录完整堆栈，方便排查；4xx（客户端错误）只记录摘要。
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${message} (requestId=${request.requestId})`,
        // 只有 Error 实例才有 stack，其他类型传 undefined。
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // 写入 HTTP 状态码并返回统一失败结构。
    response.status(status).json({
      success: false,
      error: { code, message, details },
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // 归一化：AppError → HttpException → 未知兜底，依次判断。
  private normalize(exception: unknown): NormalizedError {
    // 1. 自定义业务错误：直接取它的字段。
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    // 2. NestJS 内置 HttpException（如 NotFoundException、BadRequestException）。
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // getResponse() 可能是字符串或对象。
      const body = exception.getResponse();

      if (typeof body === 'string') {
        // HttpException 直接传字符串时的分支（如限流守卫），同样要映射成稳定错误码。
        return { status, code: codeForStatus(status), message: body };
      }

      // ValidationPipe 校验失败时，body 形如 { statusCode, message: ['email must be email'], error: 'Bad Request' }
      const payload = body as { message?: string | string[]; error?: string };
      const messages = payload.message;

      return {
        status,
        // 统一成稳定错误码（BAD_REQUEST / NOT_FOUND ...），而不是 Nest 的 "Bad Request"。
        // 前端按 code 分支，message 只用于展示。
        code: codeForStatus(status),
        // message 可能是数组（多个字段校验失败），用分号拼接成一句话。
        message: Array.isArray(messages) ? messages.join('; ') : (messages ?? exception.message),
        // details 保留原始数组，前端可以逐条展示。
        details: Array.isArray(messages) ? messages : undefined,
      };
    }

    // 3. 未知异常（如 TypeError、未处理的 Promise 拒绝等），统一当 500。
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }
}
