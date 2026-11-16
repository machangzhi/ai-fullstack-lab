/**
 * 文件作用：@Roles() 装饰器 —— 声明"哪些角色可以访问这个接口"。
 *
 * 关键概念：
 * 1. SetMetadata 把角色列表挂在方法（或类）上，本身**不做任何校验**。
 *    真正执行判断的是 RolesGuard，它通过 Reflector 读回这份元数据。
 * 2. 这就是"声明式鉴权"：权限规则写在接口旁边，一眼能看出谁能访问，
 *    而不是散落在 Service 里的 if 判断。
 * 3. 用法：
 *      @Roles('ADMIN')
 *      @UseGuards(JwtAuthGuard, RolesGuard)
 */

import { SetMetadata } from '@nestjs/common';

/** 元数据的 key，守卫读取时用同一个常量，避免字符串拼错。 */
export const ROLES_KEY = 'roles';

export type AppRole = 'ADMIN' | 'MEMBER';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
