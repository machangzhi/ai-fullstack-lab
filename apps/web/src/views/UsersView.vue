<script setup lang="ts">
/**
 * 文件作用：用户列表页（需要登录，且后端要求 ADMIN 角色）。
 *
 * 这页是前端鉴权链路的完整验证：
 *   1. 未登录访问 → 路由守卫拦下，跳 /login?redirect=/users
 *   2. 登录后返回 → axios 拦截器自动带上 Authorization
 *   3. access token 过期 → 拦截器自动刷新并重放请求（用户无感）
 *   4. 角色不足 → 后端返回 403，页面显示"无访问权限"（不跳登录页，避免死循环）
 */
import { onMounted, ref } from 'vue';
import { apiGet, ApiClientError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface UserItem {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
}

interface PaginatedUsers {
  items: UserItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const auth = useAuthStore();
const users = ref<UserItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const forbidden = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  forbidden.value = false;

  try {
    const result = await apiGet<PaginatedUsers>('/users?page=1&pageSize=20');
    users.value = result.items;
    total.value = result.total;
  } catch (e) {
    // 403 单独处理：这是"没权限"，不是"没登录"。
    if (e instanceof ApiClientError && e.status === 403) {
      forbidden.value = true;
    } else {
      error.value = e instanceof Error ? e.message : '加载失败';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="users">
    <header class="users-head">
      <h2>用户列表</h2>
      <p v-if="auth.user" class="meta">
        当前身份：{{ auth.user.name }}（{{ auth.user.role }}）
      </p>
    </header>

    <p v-if="loading">加载中…</p>

    <p v-else-if="forbidden" class="warn">
      当前账号没有访问权限（需要管理员角色）。这就是 403 与 401 的区别：不会把你踢回登录页。
    </p>

    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else>
      <p class="meta">共 {{ total }} 个用户</p>
      <table>
        <thead>
          <tr>
            <th>邮箱</th>
            <th>昵称</th>
            <th>角色</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td>{{ user.email }}</td>
            <td>{{ user.name }}</td>
            <td>{{ user.role }}</td>
            <td>{{ new Date(user.createdAt).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.users {
  max-width: 860px;
  margin: 32px auto;
  padding: 0 16px;
}

.users-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.users h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

.meta {
  color: #6b7280;
  font-size: 13px;
}

.warn {
  padding: 12px 14px;
  border-radius: 8px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 13px;
}

.error {
  color: #dc2626;
  font-size: 13px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  padding: 9px 10px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
}

th {
  color: #6b7280;
  font-weight: 500;
}
</style>
