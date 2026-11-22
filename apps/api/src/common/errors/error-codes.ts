/**
 * 文件作用：HTTP 状态码 → 稳定业务错误码的映射。
 *
 * 关键概念：
 * 1. Nest 内置异常给出的 error 字段是英文短语（"Bad Request"、"Not Found"），
 *    带空格、大小写混排，既不适合前端做分支判断，也不便于 grep 和统计。
 * 2. 错误码的约定：全大写 + 下划线 + 可穷举。
 *    前端按 code 分支，message 只用于展示（随时可能改文案或做多语言）。
 * 3. 映射放在过滤器里统一处理，Controller / Service 不需要关心——
 *    这样新增接口不可能"忘记规范"。
 */

/** 通用状态码映射：没有更具体的业务码时使用。 */
export const HTTP_STATUS_TO_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * 根据状态码取错误码。
 * 找不到映射时返回 HTTP_<状态码>，保证任何情况下都有确定值（绝不返回 undefined）。
 */
export function codeForStatus(status: number): string {
  return HTTP_STATUS_TO_CODE[status] ?? `HTTP_${status}`;
}
