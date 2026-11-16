/**
 * 文件作用：认证服务 AuthService —— 注册、登录、刷新、登出、获取当前用户。
 *
 * 双令牌设计（本日的核心）：
 * - access token：短（默认 15 分钟），每次请求携带；无状态，无法撤销。
 * - refresh token：长（默认 7 天），只用于换新令牌；服务端存**哈希**，可随时作废。
 *
 * 四个安全要求（缺一个都会留下漏洞）：
 * 1. 只存哈希：数据库泄露时攻击者拿不到可用的 refresh token。
 * 2. 轮换：每次刷新都覆盖旧哈希，旧令牌立即失效；被重放时直接 401。
 * 3. 独立密钥：access 与 refresh 用不同 secret，防止互相冒用。
 * 4. 类型校验：payload.type 必须为 refresh，防止用 access 调刷新接口。
 *
 * 为什么 refresh token 用 SHA-256 而不是 argon2：
 * 它是 **256 位高熵随机串**，不存在"弱口令"问题，慢哈希只会拖慢刷新接口。
 * argon2 是给"人选的密码"用的；随机串用快哈希足够。
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { LoginAttemptService } from './login-attempt.service';
import { JwtPayload } from './types/jwt-payload';

/** argon2 参数：显式写出便于解释，默认值即 argon2id。 */
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB，OWASP 推荐下限
  timeCost: 2,
  parallelism: 1,
};

/** 对外返回的用户信息（不含 passwordHash / refreshTokenHash）。 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
}

/** 登录/注册/刷新返回的令牌对。 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** access token 有效期（秒），前端据此提前刷新 */
  expiresIn: number;
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: Date;
};

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role.toLowerCase() as AuthUser['role'],
    createdAt: row.createdAt.toISOString(),
  };
}

/** 计算 refresh token 的存库哈希（十六进制字符串）。 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 恒定时间比较两个十六进制摘要，避免按字符逐个比较带来的时间侧信道。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** 抹平时序差异用的"假哈希"，首次需要时计算一次并缓存。 */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly attempts: LoginAttemptService,
  ) {}

  private get refreshSecret(): string {
    const secret = this.config.get<string>('JWT_REFRESH_SECRET');
    if (!secret || secret.length < 16) {
      throw new Error('JWT_REFRESH_SECRET 未配置或长度不足 16 位');
    }
    return secret;
  }

  private get accessExpiresIn(): string {
    return this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
  }

  private get refreshExpiresIn(): string {
    return this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');
  }

  /** 把 "15m" / "7d" 这类字符串转成秒数，用于返回给前端。 */
  private toSeconds(value: string): number {
    const match = /^(\d+)([smhd])$/.exec(value);
    if (!match) return Number(value) || 0;
    const amount = Number(match[1]);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
    return amount * unit;
  }

  /**
   * 签发令牌对。
   * access 用 JwtModule 配置的默认密钥（JWT_SECRET）；
   * refresh 显式传独立密钥与更长有效期，并打上 type 标记。
   */
  private async issueTokens(user: { id: string; role: 'ADMIN' | 'MEMBER' }): Promise<TokenPair> {
    const base: Omit<JwtPayload, 'type'> = { sub: user.id, role: user.role };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { ...base, type: 'access' } satisfies JwtPayload,
        { expiresIn: this.accessExpiresIn as unknown as number },
      ),
      this.jwtService.signAsync(
        { ...base, type: 'refresh' } satisfies JwtPayload,
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshExpiresIn as unknown as number,
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.toSeconds(this.accessExpiresIn),
    };
  }

  /** 保存 refresh token 哈希（轮换时覆盖旧值）。 */
  private async saveRefreshHash(userId: string, refreshToken: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: sha256(refreshToken) },
    });
  }

  /** 注册：哈希密码 → 落库 → 直接签发令牌对。 */
  async register(dto: RegisterDto): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    try {
      const row = await this.prisma.user.create({
        data: { email: dto.email, name: dto.name, passwordHash },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      });

      const tokens = await this.issueTokens(row);
      await this.saveRefreshHash(row.id, tokens.refreshToken);

      this.logger.log(`auth.register.success userId=${row.id}`);

      return { user: toAuthUser(row), tokens };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该邮箱已被注册');
      }
      throw error;
    }
  }

  /**
   * 登录：校验密码 → 签发令牌对。
   * - 失败：计入限流次数 + 审计日志（warn，不含密码）
   * - 成功：清零限流 + 审计日志（log）
   * 所有失败原因统一为"邮箱或密码错误"。
   */
  async login(dto: LoginDto, loginKey?: string): Promise<{ user: AuthUser; tokens: TokenPair }> {
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

    if (!row || !row.passwordHash || !passwordOk) {
      // 只记邮箱与次数，绝不记密码；4xx 用 warn，避免污染 error 告警。
      const failed = loginKey ? this.attempts.recordFailure(loginKey) : 0;
      this.logger.warn(
        `auth.login.failed email=${dto.email} attempts=${failed} userId=${row?.id ?? 'none'}`,
      );
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 登录成功清零，避免"白天输错两次、晚上正常登录被锁"。
    if (loginKey) this.attempts.reset(loginKey);

    const tokens = await this.issueTokens(row);
    await this.saveRefreshHash(row.id, tokens.refreshToken);

    this.logger.log(`auth.login.success userId=${row.id} role=${row.role}`);

    return { user: toAuthUser(row), tokens };
  }

  /**
   * 刷新令牌（带轮换）。
   * 流程：验签 → 校验类型 → 取用户 → 比对哈希 → 签发新对 → 覆盖哈希。
   * 任何一步失败都返回 401，不告知具体原因。
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;

    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // 类型校验：access token 不能当 refresh 用。
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    const row = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, refreshTokenHash: true },
    });

    // 用户不存在，或已登出（哈希为 null），或哈希不匹配（旧令牌被重放）。
    if (!row?.refreshTokenHash || !safeEqual(row.refreshTokenHash, sha256(refreshToken))) {
      throw new UnauthorizedException('刷新令牌已失效，请重新登录');
    }

    const tokens = await this.issueTokens(row);
    await this.saveRefreshHash(row.id, tokens.refreshToken);

    this.logger.log(`auth.refresh.success userId=${row.id}`);

    return tokens;
  }

  /** 登出：清空服务端保存的 refresh 哈希，使该用户所有刷新能力失效。 */
  async logout(userId: string): Promise<void> {
    // 说明：access token 仍未过期，无状态 JWT 无法立刻作废。
    // 生产上常用"短期 access + 黑名单"或"版本号"方案，本项目留作后续优化。
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });

    this.logger.log(`auth.logout userId=${userId}`);
  }

  /** 查询当前登录用户：身份以数据库为准，Token 只是凭证。 */
  async findMe(userId: string): Promise<AuthUser> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    if (!row) {
      throw new NotFoundException('用户不存在或已被删除');
    }

    return toAuthUser(row);
  }
}
