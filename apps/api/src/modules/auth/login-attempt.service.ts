/**
 * 文件作用：登录失败计数与锁定（防暴力破解）。
 *
 * 关键概念：
 * 1. 只对"失败"计数，成功即清零 —— 否则正常用户多次登录也会被锁。
 * 2. key = IP + 邮箱：既防"同一台机器撞多个账号"，也防"多个机器撞一个账号"。
 * 3. 时间窗口（默认 15 分钟）+ 次数上限（默认 5 次），超过返回 429。
 * 4. 本实现是**进程内存版**：单实例开发环境够用。
 *    多实例部署时必须换成 Redis（否则每个实例各算各的，限流形同虚设）。
 * 5. 定时清理过期 bucket，避免 Map 无限增长（低频扫描即可，不必用定时器）。
 */

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Bucket {
  /** 窗口内失败次数 */
  count: number;
  /** 窗口过期时间（毫秒时间戳） */
  resetAt: number;
}

@Injectable()
export class LoginAttemptService {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(config: ConfigService) {
    this.maxAttempts = Number(config.get<string>('LOGIN_MAX_ATTEMPTS', '5'));
    this.windowMs = Number(config.get<string>('LOGIN_WINDOW_MS', '900000')); // 15 分钟
  }

  /** 生成计数 key：同一 IP + 同一邮箱视为同一个攻击面。 */
  static keyOf(ip: string | undefined, email: string): string {
    return `${ip ?? 'unknown'}:${email.trim().toLowerCase()}`;
  }

  /** 请求进入时调用：已达上限则直接拒绝（此时还没有校验密码）。 */
  assertAllowed(key: string): void {
    this.cleanupIfNeeded();

    const bucket = this.buckets.get(key);
    if (!bucket || Date.now() >= bucket.resetAt) return;

    if (bucket.count >= this.maxAttempts) {
      const remainSeconds = Math.ceil((bucket.resetAt - Date.now()) / 1000);
      throw new HttpException(
        `登录尝试过于频繁，请 ${remainSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** 登录失败时调用：次数 +1，首次失败时开启新窗口。 */
  recordFailure(key: string): number {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return 1;
    }

    bucket.count += 1;
    return bucket.count;
  }

  /** 登录成功后调用：清零，避免"白天输错几次、晚上正常登录被锁"。 */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 简单的惰性清理：bucket 数量超过阈值时扫一遍过期的。 */
  private cleanupIfNeeded(): void {
    if (this.buckets.size < 1000) return;
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
