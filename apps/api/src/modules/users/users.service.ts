/**
 * 文件作用：用户服务 UsersService。
 *
 * 关键概念：
 * 1. 服务层（Service）负责业务逻辑，控制器（Controller）只负责接收请求和返回响应。
 *    这样分层后，业务逻辑可以复用、可以单独测试。
 * 2. 第 1 周用内存数组存数据（this.users），重启服务后数据丢失。
 *    第 2 周会替换成 Prisma + PostgreSQL，把数据持久化到数据库。
 *    所以这里的方法签名（list/findById/create）保持稳定，第 2 周只改内部实现。
 * 3. randomUUID().slice(0, 8) —— 生成短 ID，前缀 u_ 表示 user。
 *    第 2 周换数据库后用自增 ID 或 UUID。
 * 4. NotFoundException —— NestJS 内置异常，会被 AllExceptionsFilter 转成 404 响应。
 */

import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Paginated, PaginationQuery } from '../../common/types/api-response';
import { paginate } from '../../common/utils/pagination';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { User } from './user.entity';

/**
 * 第 1 周使用内存数据，第 2 周替换为 Prisma + PostgreSQL。
 */
@Injectable()
export class UsersService {
  // 内存用户列表，预置两条示例数据。
  private readonly users: User[] = [
    {
      id: 'u_001',
      email: 'admin@example.com',
      name: '管理员',
      role: 'admin',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    },
    {
      id: 'u_002',
      email: 'member@example.com',
      name: '学习成员',
      role: 'member',
      createdAt: new Date('2026-01-02T00:00:00.000Z').toISOString(),
    },
  ];

  // 分页 + 关键词搜索用户列表。
  list(query: ListUsersQueryDto): Paginated<User> {
    // 关键词：去空格、转小写，做大小写不敏感的模糊匹配。
    const keyword = query.keyword?.trim().toLowerCase();
    const filtered = keyword
      ? this.users.filter(
          (user) =>
            user.email.toLowerCase().includes(keyword) ||
            user.name.toLowerCase().includes(keyword),
        )
      : this.users;

    // 把 DTO 转成 PaginationQuery，调用分页工具。
    const pagination: PaginationQuery = { page: query.page, pageSize: query.pageSize };
    return paginate(filtered, pagination);
  }

  // 按 ID 查单个用户，找不到抛 404。
  findById(id: string): User {
    const user = this.users.find((item) => item.id === id);

    if (!user) {
      // NotFoundException 是 HttpException 的子类，会被过滤器转成 404。
      throw new NotFoundException(`用户 ${id} 不存在`);
    }

    return user;
  }

  // 创建用户：从 DTO 取值，生成 ID 和时间，追加到数组。
  create(dto: CreateUserDto): User {
    const user: User = {
      id: `u_${randomUUID().slice(0, 8)}`, // 短 ID，前缀区分实体类型
      email: dto.email,
      name: dto.name,
      role: dto.role ?? 'member', // 不传角色默认 member
      createdAt: new Date().toISOString(),
    };

    this.users.push(user);
    return user;
  }
}
