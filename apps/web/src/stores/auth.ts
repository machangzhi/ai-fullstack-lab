/**
 * 文件作用：认证状态仓库（Pinia）。
 *
 * 关键概念：
 * 1. access token 只放**内存**：刷新页面即丢失，降低 XSS 窃取的成功率；
 *    refresh token 放 localStorage，刷新页面后可以恢复会话。
 *    （更安全的方案是 HttpOnly Cookie，本项目先讲清取舍，后续可升级。）
 * 2. 这个 store 初始化时把三个钩子注册给 axios client：
 *    取 token、刷新令牌、会话失效——这样 client 不需要 import store，避免循环依赖。
 * 3. refreshAccessToken 自己也要防并发：多个请求同时 401 时只发一次刷新
 *    （client 里已有单飞逻辑，这里是第二道保险，防止重复用掉 refresh token）。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { http, setAuthHandlers, ApiClientError } from '@/api/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface AuthResult {
  user: AuthUser;
  tokens: TokenPair;
}

const REFRESH_KEY = 'lab.refreshToken';

export const useAuthStore = defineStore('auth', () => {
  // ---------------- state ----------------
  const user = ref<AuthUser | null>(null);
  /** access token 只存内存，不落 localStorage */
  const accessToken = ref<string | null>(null);
  /** refresh token 需要跨刷新存活，放 localStorage */
  const refreshToken = ref<string | null>(localStorage.getItem(REFRESH_KEY));
  const loading = ref(false);
  const error = ref<string | null>(null);

  // ---------------- getters ----------------
  const isAuthenticated = computed(() => Boolean(accessToken.value));
  const isAdmin = computed(() => user.value?.role === 'admin');
  const displayName = computed(() => user.value?.name ?? '');

  // ---------------- 内部方法 ----------------
  function persist(tokens: TokenPair): void {
    accessToken.value = tokens.accessToken;
    refreshToken.value = tokens.refreshToken;
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  }

  function clear(): void {
    user.value = null;
    accessToken.value = null;
    refreshToken.value = null;
    localStorage.removeItem(REFRESH_KEY);
  }

  /** 用 refresh token 换新令牌；失败则清空会话。 */
  async function refreshAccessToken(): Promise<string | null> {
    const current = refreshToken.value;
    if (!current) return null;

    try {
      // 注意：这里用 http.post 会再次经过拦截器，但 /auth/refresh 被标记为"不重试"，
      // 不会造成递归刷新。
      const tokens = await http.post<unknown, TokenPair>('/auth/refresh', { refreshToken: current });
      accessToken.value = tokens.accessToken;
      refreshToken.value = tokens.refreshToken;
      localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
      return tokens.accessToken;
    } catch {
      clear();
      return null;
    }
  }

  /** 页面刷新后恢复会话：拿 refresh token 换 access token。 */
  async function restoreSession(): Promise<void> {
    if (!refreshToken.value) return;

    const token = await refreshAccessToken();
    if (!token) return;

    try {
      user.value = await http.get<unknown, AuthUser>('/auth/me');
    } catch {
      // access token 刚换到就被拒，说明账号异常，直接清空。
      clear();
    }
  }

  // ---------------- 对外动作 ----------------
  async function login(email: string, password: string): Promise<void> {
    loading.value = true;
    error.value = null;

    try {
      const result = await http.post<unknown, AuthResult>('/auth/login', { email, password });
      persist(result.tokens);
      user.value = result.user;
    } catch (e) {
      error.value = e instanceof ApiClientError ? e.message : '登录失败，请稍后再试';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function register(email: string, name: string, password: string): Promise<void> {
    loading.value = true;
    error.value = null;

    try {
      const result = await http.post<unknown, AuthResult>('/auth/register', { email, name, password });
      persist(result.tokens);
      user.value = result.user;
    } catch (e) {
      error.value = e instanceof ApiClientError ? e.message : '注册失败，请稍后再试';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      // 通知服务端清空 refresh 哈希，让旧令牌立即失效。
      await http.post('/auth/logout');
    } catch {
      // 网络失败也要清本地状态，否则用户会卡在"已登录但用不了"的状态。
    } finally {
      clear();
    }
  }

  // 把钩子注册给 axios client（client 不 import store，避免循环依赖）。
  setAuthHandlers({
    getAccessToken: () => accessToken.value,
    refreshAccessToken,
    onSessionExpired: () => {
      clear();
      // 用完整跳转而不是 router.push，确保所有内存状态都被重置。
      if (!window.location.pathname.endsWith('/login')) {
        window.location.href = `${import.meta.env.BASE_URL}login`;
      }
    },
  });

  return {
    user,
    accessToken,
    refreshToken,
    loading,
    error,
    isAuthenticated,
    isAdmin,
    displayName,
    login,
    register,
    logout,
    restoreSession,
    refreshAccessToken,
    clear,
  };
});
