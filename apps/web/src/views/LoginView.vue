<script setup lang="ts">
/**
 * 文件作用：登录 / 注册页。
 *
 * 关键概念：
 * 1. <script setup lang="ts">：Vue 3 组合式 API 的语法糖，顶层变量直接可用于模板。
 * 2. 单文件里同时支持登录和注册，用 mode 切换——减少一个页面，逻辑高度重合。
 * 3. 提交后跳转用 router.push，而不是 window.location：
 *    前者是单页应用内跳转，不会重新加载整个应用。
 * 4. 错误提示直接展示 store 里的 error，组件不重复处理错误文案。
 *
 * 注意：SFC 文件最外层只能有 template / script / style 三种块，
 * 文件说明注释必须写在 <script setup> 内部（写在最外层会被当成模板内容解析）。
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

type Mode = 'login' | 'register';
const mode = ref<Mode>('login');

const email = ref('');
const name = ref('');
const password = ref('');

const title = computed(() => (mode.value === 'login' ? '登录' : '注册'));
const submitText = computed(() => (mode.value === 'login' ? '登录' : '注册并登录'));

function switchMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  auth.error = null;
}

async function onSubmit(): Promise<void> {
  try {
    if (mode.value === 'login') {
      await auth.login(email.value.trim(), password.value);
    } else {
      await auth.register(email.value.trim(), name.value.trim(), password.value);
    }

    // 登录后回到来源页（守卫拦截时会把原路径放在 query.redirect 里）。
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect);
  } catch {
    // 错误信息已经由 store 写入 error，这里不需要重复处理。
  }
}
</script>

<template>
  <section class="auth">
    <h2>{{ title }}</h2>

    <form class="auth-form" @submit.prevent="onSubmit">
      <label>
        <span>邮箱</span>
        <input v-model="email" type="email" placeholder="you@example.com" required autocomplete="username" />
      </label>

      <label v-if="mode === 'register'">
        <span>昵称</span>
        <input v-model="name" type="text" placeholder="2-32 个字符" required minlength="2" maxlength="32" />
      </label>

      <label>
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          :placeholder="mode === 'register' ? '至少 8 位，含字母和数字' : '请输入密码'"
          required
          :minlength="mode === 'register' ? 8 : 1"
          autocomplete="current-password"
        />
      </label>

      <p v-if="auth.error" class="auth-error">{{ auth.error }}</p>

      <button type="submit" :disabled="auth.loading">{{ auth.loading ? '处理中…' : submitText }}</button>
    </form>

    <p class="auth-switch">
      {{ mode === 'login' ? '还没有账号？' : '已有账号？' }}
      <button type="button" class="link" @click="switchMode">
        {{ mode === 'login' ? '去注册' : '去登录' }}
      </button>
    </p>
  </section>
</template>

<style scoped>
.auth {
  max-width: 380px;
  margin: 48px auto;
  padding: 28px;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 12px;
  background: var(--color-bg-elevated, #fff);
}

.auth h2 {
  margin: 0 0 20px;
  font-size: 20px;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.auth-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.auth-form input {
  padding: 9px 11px;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 8px;
  font-size: 14px;
}

.auth-form input:focus {
  outline: 2px solid #6366f1;
  outline-offset: 1px;
}

.auth-form button[type='submit'] {
  margin-top: 6px;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: #6366f1;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.auth-form button[type='submit']:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.auth-error {
  margin: 0;
  color: #dc2626;
  font-size: 13px;
}

.auth-switch {
  margin: 18px 0 0;
  font-size: 13px;
  color: #6b7280;
}

.link {
  border: none;
  background: none;
  color: #6366f1;
  cursor: pointer;
  font-size: 13px;
}
</style>
