/**
 * 文件作用：计数信号量，用于限制同时在途的模型调用数量（Week 4 Day 4）。
 *
 * 为什么需要它：
 * - 模型调用是慢 I/O，单个请求可能占用几秒到几十秒；
 * - 不限制并发时，突发流量会把供应商配额、连接池和本机内存一起打满；
 * - 限制并发是最小成本的「服务端自我保护」，比在网关层做全局限流更贴近调用点。
 *
 * 语义：
 * - active < capacity 时立即拿到槽位；
 * - 否则进入先进先出队列；等待超过 timeoutMs 抛 AiConcurrencyLimitError；
 * - release 只会生效一次（重复调用不会把计数减成负数）；
 * - 槽位可以直接「转让」给下一个等待者，active 保持不变。
 */

import { AiConcurrencyLimitError } from './reliability-errors';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Semaphore capacity must be a positive integer.');
    }
  }

  /** 当前占用槽位数量，供测试与运行状态观测使用。 */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队数量，供测试与运行状态观测使用。 */
  get queueLength(): number {
    return this.waiters.length;
  }

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new AiConcurrencyLimitError());
        }, timeoutMs),
      };

      // 注意：这里不能 unref。等待中的请求本身就是一个未完成的 Promise，
      // 若定时器也不持有事件循环，进程可能在没有发出超时错误前直接退出。
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.waiters.shift();
      if (next) {
        // 槽位转让：active 不变，等待者直接进入临界区。
        clearTimeout(next.timer);
        next.resolve(this.createRelease());
        return;
      }
      this.active -= 1;
    };
  }
}
