/**
 * 文件作用：用户实体类型 User。
 *
 * 关键概念：
 * 1. 第 1 周用 interface 定义用户结构，第 2 周迁移到 Prisma 后，这个类型会由
 *    Prisma Client 自动生成（import { User } from '@prisma/client'）。
 * 2. 字段说明：
 *    - id：用户唯一标识，格式 u_xxx（第 2 周换成数据库自增或 UUID）。
 *    - email：登录邮箱，唯一。
 *    - name：显示名。
 *    - role：角色，admin（管理员）或 member（普通成员），第 2 周做 RBAC 权限控制。
 *    - createdAt：创建时间，ISO 字符串。
 * 3. UserRole 是联合类型，限制 role 只能取这两个值，避免拼写错误。
 */

// 用户角色：管理员 / 普通成员。
export type UserRole = 'admin' | 'member';

// 用户实体：第 2 周迁移到 Prisma 后由 Prisma Client 生成。
export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}
