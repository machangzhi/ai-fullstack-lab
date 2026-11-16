/**
 * 文件作用：登录限流守卫 —— 在进入 Controller 之前拦截"已被锁定"的请求。
 *
 * 关键概念：
 * 1. 守卫只负责"检查"，不负责"计数"：
 *    计数发生在 AuthService 登录失败时（只有失败才计入）。
 * 2. 为什么在 Guard 而不是 Pipe/Pipe 之后：
 *    限流的目的是省掉无谓的 argon2 计算（每次 50ms），越早拦截越省资源。
 * 3. 守卫把计算出的 key 挂到 req.loginKey，Controller 再传给 Service，
 *    避免两边各算一遍导致 key 不一致。
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { LoginAttemptService } from '../login-attempt.service';

@Injectable()
export class LoginThrottleGuard implements CanActivate {
  constructor(private readonly attempts: LoginAttemptService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // 注意：body 已被 express.json() 解析，这里能安全读到 email。
    const email = (request.body as { email?: string } | undefined)?.email ?? '';
    const key = LoginAttemptService.keyOf(request.ip, email);

    // 已锁定则抛 429；未锁定则放行，并记录 key 供 Service 使用。
    this.attempts.assertAllowed(key);
    request.loginKey = key;
    return true;
  }
}
