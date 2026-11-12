/**
 * 文件作用：全局响应拦截器 ResponseInterceptor。
 *
 * 关键概念：
 * 1. NestJS 拦截器（Interceptor）—— 在请求处理流程中，可以在"控制器返回数据之后、
 *    响应发给客户端之前"对数据做转换。这正是统一响应结构的理想位置。
 * 2. @Injectable() —— 标记为可被 DI 容器管理的提供者。
 * 3. intercept(context, next) —— 拦截器核心方法：
 *    - context：执行上下文，可以拿到 Request/Response。
 *    - next.handle()：返回一个 Observable（RxJS），代表控制器方法的返回值。
 *    - pipe(map(...))：对控制器返回的数据做 map 转换，包装成统一结构。
 * 4. 为什么用 RxJS Observable？—— NestJS 内部基于 RxJS 管理请求生命周期，
 *    Observable 可以方便地做 map/tap/catchError 等操作，也支持异步控制器返回的 Promise。
 * 5. requestId 从 Request 上取（由 requestIdMiddleware 注入），timestamp 用当前 ISO 时间。
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, map } from 'rxjs';

/**
 * 统一成功响应结构：{ success, data, requestId, timestamp }
 */
@Injectable()
// 泛型 T：控制器返回的数据类型；拦截后返回 unknown（因为被包装成了统一结构）。
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    // 拿到当前 HTTP 请求对象，用于读取 requestId。
    const request = context.switchToHttp().getRequest<Request>();

    // next.handle() 触发后续流程并拿到控制器返回值的 Observable。
    // map 把原始 data 包装成统一结构。
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
