/**
 * 文件作用：模型供应商的熔断器（Week 4 Day 4）。
 *
 * 三种状态：
 * - closed：正常放行，统计连续失败次数；
 * - open：连续失败达到阈值后打开，直接快速失败，不再浪费一次超时；
 * - half-open：冷却期结束后只放行一个「探测请求」；成功则恢复 closed，失败则重新 open。
 *
 * 设计要点：
 * 1. 熔断按「逻辑请求」计数，而不是按重试次数计数，避免一次请求的 3 次重试直接打满阈值。
 * 2. 只有可重试的上游失败才计入；400/401 这类客户端或配置错误不应让整个供应商熔断。
 * 3. 半开状态同时只允许一个探测请求，防止恢复瞬间被流量冲垮。
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitSnapshot {
  state: CircuitState;
  failures: number;
  openedAt: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    /** 注入时钟，测试可以在不 sleep 的情况下推进时间。 */
    private readonly now: () => number = () => Date.now(),
  ) {
    if (failureThreshold < 1) {
      throw new Error('CircuitBreaker failureThreshold must be at least 1.');
    }
    if (cooldownMs < 1) {
      throw new Error('CircuitBreaker cooldownMs must be at least 1.');
    }
  }

  /**
   * 尝试获得一次调用许可。
   * 返回 false 表示熔断打开且仍在冷却期（或半开探测已被占用）。
   */
  tryAcquire(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) {
        return false;
      }
      this.state = 'half-open';
      this.probing = true;
      return true;
    }

    // half-open：同一时刻只允许一个探测请求。
    if (this.probing) {
      return false;
    }
    this.probing = true;
    return true;
  }

  /** 调用成功：无论之前失败多少次，都恢复到正常状态。 */
  onSuccess(): void {
    this.state = 'closed';
    this.failures = 0;
    this.probing = false;
  }

  /** 一个逻辑请求最终失败（重试已耗尽）。 */
  onFailure(): void {
    this.failures += 1;
    this.probing = false;

    // 半开探测失败要立刻重新打开，避免每次请求都去撞一个坏供应商。
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /**
   * 归还探测名额但不变更计数。
   * 用于「本次失败不可重试」「调用方主动取消」「还需要继续重试」等场景，
   * 避免半开状态因为一个异常分支永久卡住。
   */
  releaseProbe(): void {
    this.probing = false;
  }

  snapshot(): CircuitSnapshot {
    return { state: this.state, failures: this.failures, openedAt: this.openedAt };
  }
}
