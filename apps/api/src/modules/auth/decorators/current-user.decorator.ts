/**
 * 文件作用：@CurrentUser() 参数装饰器，从请求上取出当前登录用户的 payload。
 *
 * 关键概念：
 * 1. createParamDecorator 是 NestJS 自定义参数装饰器的标准写法，
 *    它通过 ExecutionContext 拿到当前请求，再返回要注入给方法参数的值。
 * 2. 为什么需要它：Controller 里反复写 @Req() req 再 req.user，
 *    既啰嗦又会把 Express 的 Request 类型带进业务层。
 * 3. 用法：
 *      findMe(@CurrentUser() user: JwtPayload) { ... }
 * 4. 它依赖 JwtAuthGuard 已经执行过（否则 req.user 为空），
 *    所以使用处必须同时标注 @UseGuards(JwtAuthGuard)。
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../types/jwt-payload';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): JwtPayload => {
    const request = context.switchToHttp().getRequest<Request>();
    // Guard 保证这里一定有值；没有则是编码错误（把守卫忘了），交给运行时暴露。
    return request.user as JwtPayload;
  },
);
