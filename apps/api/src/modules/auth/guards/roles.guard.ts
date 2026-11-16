/**
 * 文件作用：角色守卫 RolesGuard —— 实现 RBAC（基于角色的访问控制）。
 *
 * 关键概念：
 * 1. 执行顺序必须是 @UseGuards(JwtAuthGuard, RolesGuard)：
 *    先认证（解析出 req.user），再鉴权（看角色够不够）。反过来 req.user 还不存在。
 * 2. Reflector 用来读取 @Roles() 写入的元数据：
 *    getAllAndOverride 会先看方法上的定义，没有再看类上的。
 * 3. 没有标注 @Roles 的接口直接放行 —— 本守卫只管"声明了角色要求"的路由，
 *    避免影响其它不需要角色判断的接口。
 * 4. 角色不够返回 403（已认证但无权限），而不是 401（未认证）。
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppRole, ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 没声明角色要求：不做限制。
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    // 到这里说明 JwtAuthGuard 没生效（守卫顺序写反了）——直接拒绝，不要放过。
    if (!user) {
      throw new ForbiddenException('无访问权限');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('无访问权限');
    }

    return true;
  }
}
