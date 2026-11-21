/**
 * 文件作用：给 ChatTransport 套上一层可靠性保护（Week 4 Day 4）。
 *
 * 它实现同一个 ChatTransport 接口，因此 AiService、ToolChatService、
 * ConversationChatService 都不需要改调用方式。包装层负责四件事：
 *
 * 1. 超时：每次尝试都有独立的时间预算，到点主动 abort 上游请求；
 * 2. 重试：只对超时、网络错误、429、5xx 做有限次指数退避重试；
 * 3. 并发限制：全局信号量限制同时在途的模型调用，排队超时快速失败；
 * 4. 熔断：连续失败达到阈值后快速失败，冷却后再放一个探测请求。
 *
 * 流式调用的取舍：只做并发限制、熔断和取消信号透传，不做重试。
 * 因为流一旦已经向前端输出部分文本，重试会造成重复内容；超时也不适合整段计时，
 * 长回答本身就可能超过单次请求的预算，由客户端断开和 SDK 连接超时兜底。
 */

import { Injectable } from '@nestjs/common';
import {
  type ChatPromptMessage,
  type ChatRequestOptions,
  type ChatStreamEvent,
  type ChatStreamOptions,
  type ChatTransport,
  type ChatTransportResult,
  type ModelCatalog,
  type ToolChatMessage,
  type ToolCompletionResult,
  type ToolDefinition,
} from '../openai-chat.transport';
import { CircuitBreaker } from './circuit-breaker';
import {
  AiCallTimeoutError,
  AiCircuitOpenError,
  isRetryableModelError,
} from './reliability-errors';
import { computeBackoffMs, sleep } from './retry';
import { Semaphore } from './semaphore';

/** 可靠性层的全部可调参数；默认值面向单实例小流量服务。 */
export interface ReliabilityOptions {
  /** 同时在途的模型调用上限。 */
  maxConcurrency: number;
  /** 等待并发槽位的上限，超时返回 AI_CONCURRENCY_LIMIT。 */
  queueTimeoutMs: number;
  /** 单次逻辑请求最多尝试几次（包含首次）。 */
  maxAttempts: number;
  /** 退避基数：第 1 次重试等待 base/2 ~ base。 */
  retryBaseMs: number;
  /** 退避上限，避免指数无限增长。 */
  retryMaxMs: number;
  /** 单次尝试的时间预算。 */
  callTimeoutMs: number;
  /** 连续失败多少次后打开熔断。 */
  circuitFailureThreshold: number;
  /** 熔断打开后的冷却时间。 */
  circuitCooldownMs: number;
}

export const DEFAULT_RELIABILITY_OPTIONS: ReliabilityOptions = {
  maxConcurrency: 4,
  queueTimeoutMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 200,
  retryMaxMs: 2_000,
  callTimeoutMs: 30_000,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 30_000,
};

/** 从环境变量读取可靠性配置；非法值回退默认值，避免一个拼写错误让服务起不来。 */
export function readReliabilityOptions(
  env: Record<string, string | undefined> = process.env,
): Partial<ReliabilityOptions> {
  return {
    maxConcurrency: readInt(env.AI_MAX_CONCURRENCY, 1, 64),
    queueTimeoutMs: readInt(env.AI_QUEUE_TIMEOUT_MS, 100, 60_000),
    maxAttempts: readInt(env.AI_MAX_ATTEMPTS, 1, 5),
    retryBaseMs: readInt(env.AI_RETRY_BASE_MS, 10, 10_000),
    retryMaxMs: readInt(env.AI_RETRY_MAX_MS, 10, 30_000),
    callTimeoutMs: readInt(env.AI_CALL_TIMEOUT_MS, 1_000, 300_000),
    circuitFailureThreshold: readInt(env.AI_CIRCUIT_FAILURE_THRESHOLD, 1, 100),
    circuitCooldownMs: readInt(env.AI_CIRCUIT_COOLDOWN_MS, 100, 600_000),
  };
}

function readInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

@Injectable()
export class ReliableChatTransport implements ChatTransport {
  private readonly options: ReliabilityOptions;
  private readonly semaphore: Semaphore;
  /** 每个模型档案独立熔断：一个供应商故障不应拖垮另一个可用模型。 */
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly inner: ChatTransport,
    options: Partial<ReliabilityOptions> = {},
  ) {
    // 逐项兜底：环境变量缺省时 readReliabilityOptions 会给出 undefined，
    // 直接展开会把这些键覆盖成 undefined，导致信号量容量变成非法值。
    this.options = {
      maxConcurrency: options.maxConcurrency ?? DEFAULT_RELIABILITY_OPTIONS.maxConcurrency,
      queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_RELIABILITY_OPTIONS.queueTimeoutMs,
      maxAttempts: options.maxAttempts ?? DEFAULT_RELIABILITY_OPTIONS.maxAttempts,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_RELIABILITY_OPTIONS.retryBaseMs,
      retryMaxMs: options.retryMaxMs ?? DEFAULT_RELIABILITY_OPTIONS.retryMaxMs,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULT_RELIABILITY_OPTIONS.callTimeoutMs,
      circuitFailureThreshold:
        options.circuitFailureThreshold ?? DEFAULT_RELIABILITY_OPTIONS.circuitFailureThreshold,
      circuitCooldownMs: options.circuitCooldownMs ?? DEFAULT_RELIABILITY_OPTIONS.circuitCooldownMs,
    };
    this.semaphore = new Semaphore(this.options.maxConcurrency);
  }

  /** 运行时装配入口：配置只来自环境变量，业务层无感知。 */
  static fromEnv(
    inner: ChatTransport,
    env: Record<string, string | undefined> = process.env,
  ): ReliableChatTransport {
    return new ReliableChatTransport(inner, readReliabilityOptions(env));
  }

  complete(
    messages: ChatPromptMessage[],
    options?: ChatRequestOptions,
  ): Promise<ChatTransportResult> {
    return this.runUnary(
      options?.profileId,
      (signal) => this.inner.complete(messages, { ...options, signal }),
      options?.signal,
    );
  }

  completeWithTools(
    messages: ToolChatMessage[],
    tools: ToolDefinition[],
    options?: ChatRequestOptions,
  ): Promise<ToolCompletionResult> {
    return this.runUnary(
      options?.profileId,
      (signal) => this.inner.completeWithTools(messages, tools, { ...options, signal }),
      options?.signal,
    );
  }

  async *stream(
    messages: ChatPromptMessage[],
    options?: ChatStreamOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const breaker = this.breakerFor(options?.profileId);
    if (!breaker.tryAcquire()) {
      throw new AiCircuitOpenError();
    }

    const release = await this.acquireSlot(breaker);

    let finished = false;
    try {
      yield* this.inner.stream(messages, options);
      finished = true;
      breaker.onSuccess();
    } catch (error) {
      // 与普通调用一致：只有上游可重试失败才计入熔断，客户端错误与主动取消不计。
      if (!options?.signal?.aborted && isRetryableModelError(error)) {
        breaker.onFailure();
      } else {
        breaker.releaseProbe();
      }
      throw error;
    } finally {
      // 消费者提前 break 不会走到 onSuccess，需要归还探测名额，避免半开状态卡死。
      if (!finished) {
        breaker.releaseProbe();
      }
      release();
    }
  }

  /** 目录与预算查询不经过限流和熔断：它们不产生模型费用。 */
  listModels(): ModelCatalog {
    return this.inner.listModels();
  }

  getModelLimits(profileId?: string): { contextWindow: number; maxOutputTokens: number } {
    return this.inner.getModelLimits(profileId);
  }

  /**
   * 非流式调用的统一执行器：并发槽位 → 熔断许可 → 单次超时调用 → 失败退避重试。
   * 槽位覆盖整个逻辑请求（含重试与退避），保证「在途」数量始终受控。
   */
  private async runUnary<T>(
    profileId: string | undefined,
    attempt: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    const breaker = this.breakerFor(profileId);
    if (!breaker.tryAcquire()) {
      throw new AiCircuitOpenError();
    }

    const release = await this.acquireSlot(breaker);

    let lastError: unknown;

    try {
      for (let round = 1; round <= this.options.maxAttempts; round += 1) {
        // 第一轮已经持有许可；后续轮次重新争取，熔断可能在退避期间被其它请求打开。
        if (round > 1 && !breaker.tryAcquire()) {
          throw new AiCircuitOpenError();
        }

        try {
          const result = await this.withAttemptTimeout(attempt, outerSignal);
          breaker.onSuccess();
          return result;
        } catch (error) {
          lastError = error;
          const aborted = outerSignal?.aborted === true;

          if (aborted || !isRetryableModelError(error) || round === this.options.maxAttempts) {
            // 只有上游可重试错误才算供应商故障；客户端取消或参数错误不参与熔断。
            if (!aborted && isRetryableModelError(error)) {
              breaker.onFailure();
            } else {
              breaker.releaseProbe();
            }
            throw error;
          }

          breaker.releaseProbe();
          try {
            await sleep(
              computeBackoffMs(round, this.options.retryBaseMs, this.options.retryMaxMs),
              outerSignal,
            );
          } catch {
            throw lastError;
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Model call failed.');
    } finally {
      release();
    }
  }

  /** 单次尝试的超时控制：定时 abort，并把「超时」和「调用方取消」区分开。 */
  private async withAttemptTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;

    const onOuterAbort = (): void => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) {
        controller.abort();
      } else {
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.callTimeoutMs);

    try {
      return await run(controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new AiCallTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 排队拿槽位；排队超时时要归还半开探测名额，否则该档案再也不会被探测。 */
  private async acquireSlot(breaker: CircuitBreaker): Promise<() => void> {
    try {
      return await this.semaphore.acquire(this.options.queueTimeoutMs);
    } catch (error) {
      breaker.releaseProbe();
      throw error;
    }
  }

  private breakerFor(profileId?: string): CircuitBreaker {
    // 未指定档案时归到同一个默认桶；真实装配下 profileId 总会由 LlmService 解析。
    const key = profileId ?? '__default__';
    const existing = this.breakers.get(key);
    if (existing) {
      return existing;
    }

    const breaker = new CircuitBreaker(
      this.options.circuitFailureThreshold,
      this.options.circuitCooldownMs,
    );
    this.breakers.set(key, breaker);
    return breaker;
  }
}
