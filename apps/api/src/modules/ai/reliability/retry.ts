/**
 * 文件作用：重试退避的纯函数与可取消的 sleep（Week 4 Day 4）。
 *
 * 为什么需要退避：
 * - 供应商 429/5xx 时立即重试，等于在对方最忙的时候继续加压；
 * - 固定间隔会让多个请求「同频」重试，形成尖峰；
 * - 指数退避把间隔拉长，再叠加随机抖动，把重试打散到不同时间点。
 */

/**
 * 计算第 attempt 次失败后的等待时间（attempt 从 1 开始）。
 *
 * 采用「半抖动」：上限为 base * 2^(attempt-1) 且不超过 maxMs，
 * 实际等待落在上限的 50% ~ 100% 之间。
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/**
 * 可被 AbortSignal 取消的 sleep。
 * 上层断开连接时不需要等完整个退避周期，尽快释放槽位。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sleep aborted.'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Sleep aborted.'));
    };

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
