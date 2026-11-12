/**
 * 文件作用：前端 API 客户端封装。
 *
 * 关键概念：
 * 1. 统一请求封装 —— 所有 API 调用走 apiGet/apiPost，统一处理：
 *    - 拼接 baseUrl（来自 VITE_API_BASE_URL，默认 /api）
 *    - 设置请求头（Accept、Content-Type）
 *    - 解析响应体（统一结构 { success, data/error }）
 *    - 抛出 ApiClientError（含 code、status，方便上层处理）
 * 2. 第 1 周用原生 fetch，第 2 周会换成 axios（支持拦截器、自动 token 续期、取消请求等）。
 *    但 apiGet/apiPost 的函数签名保持不变，业务代码不用改。
 * 3. ApiResponse<T> 和后端的类型定义保持一致，前后端共享同一份响应结构。
 * 4. ApiClientError —— 自定义错误类，携带 code 和 status，
 *    组件层可以 catch 后根据 code 显示不同的提示。
 */

// 成功响应结构，与后端 ApiSuccess<T> 一致。
export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

// 失败响应结构，与后端 ApiFailure 一致。
export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}

// 联合类型。
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

// API 客户端错误：携带 code 和 HTTP status，方便上层处理。
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

// 基础 URL：从环境变量读，默认 /api（开发时走 Vite 代理到后端 3000 端口）。
// replace(/\/$/, '') 去掉末尾的 /，避免拼接出 // 双斜杠。
const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

// 内部请求方法：处理 fetch + 统一响应解析 + 错误抛出。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 发起请求，合并默认头和调用方传入的头。
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  // 解析 JSON，解析失败（如返回 HTML）则为 null。
  const body = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  // 响应体不是合法 JSON，抛出错误。
  if (!body) {
    throw new ApiClientError(`请求失败（HTTP ${response.status}）`, 'INVALID_RESPONSE', response.status);
  }

  // 业务失败（success:false），抛出带 code 和 message 的错误。
  if (!body.success) {
    throw new ApiClientError(body.error.message, body.error.code, response.status);
  }

  // 成功，返回 data 字段（剥掉统一外壳，业务层只关心数据本身）。
  return body.data;
}

// GET 请求封装。
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

// POST 请求封装：payload 会被 JSON.stringify。
export function apiPost<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
