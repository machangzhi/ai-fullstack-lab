/**
 * 文件作用：并发与重试工具函数。
 *
 * 关键概念：
 * 1. withTimeout —— 给一个 Promise 加超时保护。用 Promise.race 让"任务"和"超时计时器"赛跑，
 *    谁先完成就用谁的结果。超时后 reject 一个 Error。finally 里清掉计时器，避免内存泄漏。
 *    后续调用大模型 API 时必须用这个，防止模型无响应导致请求挂死。
 * 2. withRetry —— 指数退避重试。失败后等待 baseDelayMs * 2^attempt 毫秒再重试，
 *    上限 maxDelayMs（防止等待太久）。shouldRetry 可以自定义哪些错误需要重试。
 *    适合调用不稳定的外部接口（模型、第三方 API）。
 * 3. runWithConcurrency —— 并发受限的批量执行器。
 *    不是 Promise.all（全并发），也不是 for-await（串行），而是维护 N 个"工人"同时跑，
 *    每个工人完成一个任务后立刻拿下一个，控制并发数在 limit 以内。
 *    适合批量调用模型时防止触发限流（比如同时最多 5 个请求）。
 */

// 重试选项：retries 是重试次数（不含首次），baseDelayMs 是初始退避毫秒。
export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * 给任务加超时。超时后 reject Error，原任务继续运行（不会被取消，但结果会被忽略）。
 */
export async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    // 超时 Promise：到点 reject。
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    // 竞赛：任务完成 或 超时，谁先用谁。
    return await Promise.race([task, timeout]);
  } finally {
    // 无论成功失败，都清掉计时器，防止它在后台继续触发。
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 指数退避重试。attempt 从 0 开始：第 0 次失败等 baseDelayMs，第 1 次失败等 baseDelayMs*2...
 */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs = 2_000, shouldRetry = () => true } = options;
  let lastError: unknown;

  // attempt 从 0 到 retries，共 retries+1 次尝试（首次 + retries 次重试）。
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      // 最后一次尝试或不应该重试时，跳出循环。
      if (attempt === retries || !shouldRetry(error)) {
        break;
      }

      // 指数退避：baseDelayMs * 2^attempt，不超过 maxDelayMs。
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // 所有尝试都失败，抛出最后一次错误。
  throw lastError;
}

/**
 * 并发受限执行器：用于批量调用模型或外部接口时控制并发。
 * 维护 concurrency 个工人，每个工人不断从 items 中拿下一个任务执行，直到全部完成。
 * 结果按原始顺序保存在 results 数组中（即使执行顺序不同）。
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // 预分配结果数组，保证结果顺序与输入顺序一致。
  const results: R[] = new Array(items.length);
  // 并发数：至少 1，最多不超过 items 长度。
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  // cursor：下一个待处理的任务索引，所有工人共享。
  let cursor = 0;

  // 创建 concurrency 个工人，每个工人循环取任务。
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      // 原子地取走当前索引并自增（JS 单线程，这里不会有竞态）。
      const index = cursor;
      cursor += 1;
      // 执行任务并把结果放到对应位置。
      results[index] = await worker(items[index], index);
    }
  });

  // 等待所有工人完成。
  await Promise.all(runners);
  return results;
}
