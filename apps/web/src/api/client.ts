/**
 * 文件作用：基于 axios 的 API 客户端，带自动附加 Token 与 401 自动刷新。
 *
 * 与第 1 周 fetch 版的差别：
 *   1. 拦截器：请求前自动加 Authorization，响应后自动拆统一外壳。
 *   2. 401 自动续期：access token 过期时，用 refresh token 换一次新令牌并**重放原请求**。
 *   3. 单飞刷新：并发 10 个请求同时 401，只发起 1 次刷新，其余排队等结果。
 *
 * 关键概念：
 *   - 为什么要把"取 token / 刷新 / 失效回调"做成可注入的钩子：
 *     client 不能直接 import store（store 又会 import client），会形成循环依赖。
 *     由 store 在初始化时把函数注册进来，client 只负责调用。
 *   - 为什么只重试一次：避免"刷新成功但新 token 仍被拒"时无限循环。
 */

import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

/** 成功响应外壳，与后端 ApiSuccess<T> 一致。 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

/** 失败响应外壳，与后端 ApiFailure 一致。 */
export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
  timestamp: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** 业务错误：携带稳定 code 与 HTTP 状态，供组件按 code 分支。 */
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

/** 由 auth store 注入的三个钩子。 */
interface AuthHandlers {
  getAccessToken: () => string | null;
  /** 刷新成功返回新 access token，失败返回 null（或抛错） */
  refreshAccessToken: () => Promise<string | null>;
  /** 会话彻底失效：清本地状态并跳登录页 */
  onSessionExpired: () => void;
}

let handlers: AuthHandlers = {
  getAccessToken: () => null,
  refreshAccessToken: async () => null,
  onSessionExpired: () => {},
};

/** auth store 初始化时调用一次。 */
export function setAuthHandlers(next: AuthHandlers): void {
  handlers = next;
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export const http = axios.create({
  baseURL: baseUrl,
  timeout: 20000,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
});

/* ----------------------------- 请求拦截器 ----------------------------- */
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = handlers.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/* ----------------------------- 响应拦截器 ----------------------------- */

/** 标记"已经重试过"的请求，防止无限刷新循环。 */
interface RetriableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

/** 单飞刷新：并发 401 时共用同一个 Promise，避免把 refresh token 用废。 */
let refreshPromise: Promise<string | null> | null = null;

function refreshOnce(): Promise<string | null> {
  refreshPromise ??= handlers.refreshAccessToken().finally(() => {
    // 无论成功失败都清空，下一次 401 才能重新发起。
    refreshPromise = null;
  });
  return refreshPromise;
}

http.interceptors.response.use(
  // 成功：直接剥掉统一外壳，业务层拿到的就是 data
  (response: AxiosResponse<ApiResponse<unknown>>) => {
    const body = response.data;
    if (body && typeof body === 'object' && 'success' in body && body.success) {
      return body.data as never;
    }
    return response.data as never;
  },

  // 失败：统一转换成 ApiClientError，并处理 401 续期
  async (error: AxiosError<ApiFailure>) => {
    const status = error.response?.status ?? 0;
    const payload = error.response?.data;
    const config = error.config as RetriableConfig | undefined;
    const isAuthEndpoint = config?.url?.includes('/auth/login') || config?.url?.includes('/auth/refresh');

    // 401 且不是登录/刷新接口本身，且没重试过 → 尝试刷新一次
    if (status === 401 && config && !config._retried && !isAuthEndpoint) {
      config._retried = true;
      const newToken = await refreshOnce();

      if (newToken) {
        config.headers.Authorization = `Bearer ${newToken}`;
        // 重放原请求：对调用方完全透明，它只会看到"请求成功了"。
        return http.request(config);
      }

      handlers.onSessionExpired();
    }

    const message = payload?.error?.message ?? `请求失败（HTTP ${status || 'NETWORK'}）`;
    const code = payload?.error?.code ?? 'NETWORK_ERROR';
    return Promise.reject(new ApiClientError(message, code, status));
  },
);

/* ------------------------------ 简写方法 ------------------------------ */

export function apiGet<T>(path: string): Promise<T> {
  // 拦截器已把响应剥成 data 本身，但 axios 的类型签名仍认为返回 AxiosResponse，
  // 这里用 unknown 中转做一次断言（运行期行为由拦截器保证）。
  return http.get(path) as unknown as Promise<T>;
}

export function apiPost<T>(path: string, payload?: unknown): Promise<T> {
  return http.post(path, payload) as unknown as Promise<T>;
}
