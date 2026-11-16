/**
 * 文件作用：认证服务 AuthService —— 注册、登录、获取当前用户。
 *
 * 关键概念：
 * 1. 密码永远只存哈希。argon2id 同时消耗 CPU 和内存，抗 GPU 暴力破解；
 *    库内部使用恒定时间比较，避免"逐位猜密码"的时间侧信道。
 * 2. 登录失败统一返回 401 + "邮箱或密码错误"，不区分"用户不存在"与"密码错误"，
 *    否则攻击者可以批量枚举平台上有哪些注册邮箱。
 * 3. 用户不存在时也执行一次 argon2.verify（用一个固定的假哈希），
 *    抹平"查不到用户立即返回"与"校验密码失败"之间的耗时差异（时序攻击）。
 * 4. JWT 只携带 sub + role，绝不携带密码或隐私字段——payload 是明文的。
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './types/jwt-payload';

/** argon2 参数：显式写出便于解释，默认值即 argon2id。 */
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB，OWASP 推荐下限
  timeCost: 2,
  parallelism: 1,
};

/** 对外返回的用户信息（不含 passwordHash）。 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
}

/** 数据库行的最小结构，用于映射。 */
type UserRow = {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: Date;
};

/** 数据库行 → 对外实体（与第 1 周的 API 契约保持一致）。 */
function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role.toLowerCase() as AuthUser['role'],
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class AuthService {
  /**
   * 用于抹平耗时的"假哈希"。
   * 首次需要时计算一次并缓存，避免每次登录都额外哈希。
   */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /** 签发访问令牌。只放 sub 与 role，拉开"最小信息原则"。 */
  private async signToken(user: { id: string; role: 'ADMIN' | 'MEMBER' }): Promise<string> {
    const payload: JwtPayload = { sub: user.id, role: user.role };
    return this.jwtService.signAsync(payload);
  }

  /** 注册：哈希密码 → 落库 → 直接签发 Token（注册后免登录）。 */
  async register(dto: RegisterDto): Promise<{ user: AuthUser; accessToken: string }> {
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    try {
      const row = await this.prisma.user.create({
        data: { email: dto.email, name: dto.name, passwordHash },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      });

      return { user: toAuthUser(row), accessToken: await this.signToken(row) };
    } catch (error) {
      // 邮箱唯一索引冲突：交给数据库判定，避免"先查再插"的并发窗口。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该邮箱已被注册');
      }
      throw error;
    }
  }

  /** 登录：校验密码 → 签发 Token。所有失败原因统一为"邮箱或密码错误"。 */
  async login(dto: LoginDto): Promise<{ user: AuthUser; accessToken: string }> {
    const row = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        passwordHash: true,
      },
    });

    // 用户不存在时也做一次等价消耗的校验，避免通过响应时间判断账号是否存在。
    this.dummyHash ??= argon2.hash('timing-equalizer', ARGON2_OPTIONS);
    const hashToCheck = row?.passwordHash ?? (await this.dummyHash);
    const passwordOk = await argon2.verify(hashToCheck, dto.password).catch(() => false);

    // 注意 && 的顺序：row 为空时不再往下判断，但上面的 verify 已经执行过。
    if (!row || !row.passwordHash || !passwordOk) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    return { user: toAuthUser(row), accessToken: await this.signToken(row) };
  }

  /**
   * 查询当前登录用户。
   * 为什么要回库查，而不是直接返回 Token 里的信息：
   * Token 签发后用户可能被改名、降权、删除，回库才能拿到最新状态。
   */
  async findMe(userId: string): Promise<AuthUser> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    if (!row) {
      // Token 合法但用户已被删除：返回 401 更合适（身份失效），这里用 404 便于区分排查。
      throw new NotFoundException('用户不存在或已被删除');
    }

    return toAuthUser(row);
  }
}
