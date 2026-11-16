/**
 * 文件作用：JWT 鉴权守卫（Guard）。
 *
 * 关键概念：
 * 1. Guard 在请求生命周期里的位置是：Middleware → **Guard** → Interceptor → Pipe → Controller。
 *    也就是说它在参数校验之前执行——未登录的请求连"参数格式对不对"都不检查，直接 401。
 * 2. 为什么不用 passport-jwt：这里只需"取 Header → 验签 → 挂用户"，
 *    自己写 20 行比引入 passport 策略、序列化、反序列化更直观。
 * 3. 校验通过后把 payload 挂到 req.user，Controller 通过 @CurrentUser() 读取。
 *    req.user 的类型扩展写在 src/common/types/express.d.ts（声明合并）。
 * 4. 任何异常都翻译成 401 且**不暴露具体原因**：
 *    "签名错误"、"已过期"、"格式不对"对攻击者都是有用的信息。
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { JwtPayload } from '../types/jwt-payload';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    // 标准格式：Authorization: Bearer <token>
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少访问令牌');
    }

    const token = header.slice('Bearer '.length).trim();

    try {
      // verifyAsync 会同时校验签名和 exp（过期时间），任一不通过都会抛错。
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      // 刻意不区分"过期"与"伪造"，避免给攻击者提供判断依据。
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
  }
}
