/**
 * 文件作用：用户服务 UsersService（第 2 周版：数据来自 PostgreSQL）。
 *
 * 与第 1 周的差别：
 * 1. 所有方法从「同步返回」变成「返回 Promise」—— 数据库访问是异步 I/O。
 *    调用方（Controller）不需要写 await，Nest 会自动等待 Promise 再序列化响应。
 * 2. 分页从「内存数组切片」改成「数据库 LIMIT/OFFSET + COUNT」，
 *    数据量再大也不会把整表读进内存。
 * 3. 「找不到」不再靠数组 find 判空，而是数据库返回 null 后抛 NotFoundException。
 * 4. 邮箱重复由数据库唯一索引兜底，捕获 Prisma 的 P2002 错误转成 409 Conflict。
 *
 * 关键概念：
 * - select：只查需要的字段。密码哈希绝不能出现在响应里，所以显式列字段，
 *   而不是「查全部再删掉」——白名单比黑名单安全。
 * - toUser()：把数据库行（Date 类型）映射成对外实体（ISO 字符串），
 *   保证 API 契约与第 1 周完全一致，前端不需要改。
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Paginated, PaginationQuery } from '../../common/types/api-response';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { User } from './user.entity';

/** 对外暴露的用户字段白名单：永远不包含 passwordHash。 */
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

/** 数据库行 -> API 实体的映射结果类型。 */
type UserRow = {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: Date;
};

/**
 * 映射函数：数据库类型 -> 对外类型。
 * - Date 转 ISO 字符串：JSON 序列化后与第 1 周格式一致（2026-01-01T00:00:00.000Z）
 * - 角色枚举 ADMIN/MEMBER 转小写：保持前端已有的 'admin' / 'member' 契约
 */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role.toLowerCase() as User['role'],
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  // PrismaService 由全局 PrismaModule 提供，无需在本模块 imports。
  constructor(private readonly prisma: PrismaService) {}

  // 分页 + 关键词搜索用户列表。
  async list(query: ListUsersQueryDto): Promise<Paginated<User>> {
    const keyword = query.keyword?.trim();

    // where 条件：关键词同时匹配邮箱或姓名，mode: 'insensitive' 走 PostgreSQL 的大小写不敏感匹配。
    const where: Prisma.UserWhereInput = keyword
      ? {
          OR: [
            { email: { contains: keyword, mode: 'insensitive' } },
            { name: { contains: keyword, mode: 'insensitive' } },
          ],
        }
      : {};

    // PaginationQuery 的字段是可选的，这里给出与 DTO 默认值一致的兜底。
    const pagination: PaginationQuery = { page: query.page ?? 1, pageSize: query.pageSize ?? 10 };
    const page = pagination.page as number;
    const pageSize = pagination.pageSize as number;
    const skip = (page - 1) * pageSize;

    // $transaction 把两条查询放进同一个事务，保证 total 与 items 来自同一快照
    // （否则并发写入时可能出现 total=10 但 items 只有 9 条）。
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map(toUser),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // 按 ID 查单个用户，找不到抛 404。
  async findById(id: string): Promise<User> {
    // findUnique 只能用于唯一字段（这里是主键 id）。
    const row = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });

    if (!row) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }

    return toUser(row);
  }

  // 创建用户：邮箱唯一性由数据库保证，重复时转成 409。
  async create(dto: CreateUserDto): Promise<User> {
    try {
      const row = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          // DTO 里是小写，数据库枚举是大写，这里做一次显式转换。
          role: (dto.role ?? 'member').toUpperCase() as 'ADMIN' | 'MEMBER',
          // 管理员创建的账号暂不设密码，等用户自行设置（第 3 天做注册流程）
          passwordHash: null,
        },
        select: USER_SELECT,
      });

      return toUser(row);
    } catch (error) {
      // Prisma 唯一约束冲突的固定错误码是 P2002。
      // 不用「先查再插」——那中间有并发窗口，两次请求都会通过检查。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`邮箱 ${dto.email} 已存在`);
      }
      throw error;
    }
  }
}
