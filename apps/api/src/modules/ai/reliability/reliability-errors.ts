/**
 * 文件作用：模型调用的可靠性错误与「是否值得重试」的判断（Week 4 Day 4）。
 *
 * 关键概念：
 * 1. 错误分两类——可重试（超时、网络中断、429、5xx）和不可重试（配置错误、未知模型、401/400）。
 *    对不可重试错误做重试只会重复失败并放大费用。
 * 2. 这些错误属于「可靠性层」自己的语义，不依赖 Nest 或 AppError；
 *    AiService 在出口统一把它们映射成稳定的业务错误码。
 * 3. 不把供应商原始响应放进 message，避免密钥或内网地址进入日志。
 */

import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { EmptyChatResponseError } from '../openai-chat.transport';

/** 本次尝试超过服务端设定的时间预算。与客户端主动断开区分开。 */
export class AiCallTimeoutError extends Error {
  constructor(message = 'Model call exceeded the configured timeout.') {
    super(message);
    this.name = 'AiCallTimeoutError';
  }
}

/** 并发槽位在队列里等待超时：服务端当前没有能力再接新请求。 */
export class AiConcurrencyLimitError extends Error {
  constructor(message = 'Too many concurrent model calls.') {
    super(message);
    this.name = 'AiConcurrencyLimitError';
  }
}

/** 熔断器处于打开状态：直接快速失败，不再把请求发给明显不可用的供应商。 */
export class AiCircuitOpenError extends Error {
  constructor(message = 'Model provider circuit is open.') {
    super(message);
    this.name = 'AiCircuitOpenError';
  }
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试：调用超时、网络不可达、429 限流、5xx、空回复（可能是偶发的下游抖动）。
 * 不可重试：模型档案配置错误、客户端传了不存在的模型、鉴权失败、请求参数错误。
 */
export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof AiCallTimeoutError) {
    return true;
  }
  if (error instanceof EmptyChatResponseError) {
    return true;
  }
  if (error instanceof APIConnectionTimeoutError || error instanceof APIConnectionError) {
    return true;
  }
  if (error instanceof APIError) {
    return isRetryableStatus(error.status);
  }

  // 兼容测试替身或其它兼容实现：只要带有数字 status 且属于 429/5xx 也按可重试处理。
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && isRetryableStatus(status);
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status ?? 0) >= 500;
}
