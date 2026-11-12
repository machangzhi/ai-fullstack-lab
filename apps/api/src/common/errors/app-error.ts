/**
 * 文件作用：业务错误基类 AppError。
 *
 * 关键概念：
 * 1. 为什么需要自定义错误类？—— 原生 Error 只有 message，无法表达 HTTP 状态码、稳定错误码、
 *    可重试性等信息。AppError 把这些信息统一封装，AllExceptionsFilter 识别后生成标准失败响应。
 * 2. code —— 稳定错误码（如 'USER_NOT_FOUND'），前端可根据 code 做差异化处理，
 *    比依赖 message 文案更可靠（文案可能改，code 不变）。
 * 3. status —— HTTP 状态码，默认 500。
 * 4. details —— 附加详情（如校验失败的字段列表），可选。
 * 5. retryable getter —— 5xx 或限流错误视为可重试，方便后续 AI 调用等场景的自动重试逻辑判断。
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
    readonly details?: unknown,
  ) {
    super(message);
    // 重新设置 name，便于日志/堆栈中识别是 AppError 而非普通 Error。
    this.name = 'AppError';
  }

  // 可重试判断：服务端 5xx 错误或限流错误可以重试，4xx 一般是客户端问题，重试也没用。
  get retryable(): boolean {
    return this.status >= 500 || this.code === 'RATE_LIMITED';
  }
}
