<script setup lang="ts">
import { computed, ref } from 'vue';
import { apiPost } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface ChatTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ChatReply {
  reply: string;
  model: string;
  usage: ChatTokenUsage | null;
}

const auth = useAuthStore();
const message = ref('');
const result = ref<ChatReply | null>(null);
const loading = ref(false);
const errorMessage = ref('');

const canSubmit = computed(
  () =>
    auth.isAuthenticated &&
    !loading.value &&
    message.value.trim().length > 0 &&
    message.value.length <= 8000,
);

async function submitMessage(): Promise<void> {
  if (!canSubmit.value) return;

  loading.value = true;
  errorMessage.value = '';

  try {
    result.value = await apiPost<ChatReply>(
      '/ai/chat',
      { message: message.value.trim() },
      // 略高于服务端默认 30 秒，避免浏览器先于 DeepSeek 超时。
      { timeout: 40_000 },
    );
  } catch (error) {
    result.value = null;
    errorMessage.value = error instanceof Error ? error.message : '模型请求失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <!-- eslint-disable vue/max-attributes-per-line, vue/singleline-html-element-content-newline -->
  <section class="chat-panel" aria-labelledby="deepseek-chat-title">
    <header class="chat-header">
      <div>
        <p class="eyebrow">Week 03 · Day 02</p>
        <h2 id="deepseek-chat-title">DeepSeek 第一次对话</h2>
      </div>
      <span class="tag">单轮 · 非流式</span>
    </header>

    <p class="description">问题只发送当前这一条消息；system 提示词和 API Key 均保留在服务端。</p>

    <div v-if="!auth.isAuthenticated" class="login-tip">
      <span>登录后即可调用 DeepSeek，避免匿名请求消耗模型额度。</span>
      <RouterLink to="/login">去登录</RouterLink>
    </div>

    <form class="chat-form" @submit.prevent="submitMessage">
      <label for="chat-message">你的问题</label>
      <textarea
        id="chat-message"
        v-model="message"
        rows="4"
        maxlength="8000"
        :disabled="loading || !auth.isAuthenticated"
        placeholder="例如：用三句话解释 system、user 和 assistant 的区别"
      />
      <div class="form-footer">
        <span class="character-count">{{ message.length }} / 8000</span>
        <button class="button primary" type="submit" :disabled="!canSubmit">
          {{ loading ? '等待 DeepSeek 回复…' : '发送问题' }}
        </button>
      </div>
    </form>

    <p v-if="errorMessage" class="error-text" role="alert">
      {{ errorMessage }}
    </p>

    <p v-else-if="loading" class="loading-text" role="status">
      正在等待模型返回完整回复，本次请求不会自动重试。
    </p>

    <article v-if="result" class="answer" aria-live="polite">
      <div class="answer-header">
        <strong>Assistant</strong>
        <span>{{ result.model }}</span>
      </div>
      <p class="reply">
        {{ result.reply }}
      </p>
      <dl v-if="result.usage" class="usage">
        <div>
          <dt>输入 Token</dt>
          <dd>{{ result.usage.promptTokens }}</dd>
        </div>
        <div>
          <dt>输出 Token</dt>
          <dd>{{ result.usage.completionTokens }}</dd>
        </div>
        <div>
          <dt>合计</dt>
          <dd>{{ result.usage.totalTokens }}</dd>
        </div>
      </dl>
    </article>
  </section>
</template>

<style scoped>
.chat-panel {
  padding: 20px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.chat-header,
.form-footer,
.answer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 6px;
  color: var(--color-accent);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.chat-header h2 {
  margin: 0;
  font-size: 18px;
}

.tag {
  flex: 0 0 auto;
  padding: 3px 9px;
  color: var(--color-text-muted);
  font-size: 12px;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: 999px;
}

.description,
.login-tip,
.loading-text {
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1.7;
}

.description {
  margin: 12px 0 16px;
}

.login-tip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
  padding: 10px 12px;
  background: var(--color-surface-muted);
  border-radius: var(--radius-md);
}

.login-tip a {
  font-weight: 600;
}

.chat-form {
  display: grid;
  gap: 8px;
}

.chat-form label {
  font-size: 14px;
  font-weight: 600;
}

.chat-form textarea {
  width: 100%;
  min-height: 112px;
  padding: 12px;
  resize: vertical;
  color: var(--color-text);
  font: inherit;
  line-height: 1.6;
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
}

.chat-form textarea:focus {
  border-color: var(--color-accent);
  outline: 3px solid rgba(79, 70, 229, 0.12);
}

.chat-form textarea:disabled {
  background: var(--color-surface-muted);
  cursor: not-allowed;
}

.character-count {
  color: var(--color-text-muted);
  font-size: 12px;
}

.error-text {
  margin: 14px 0 0;
  color: #a32222;
  font-size: 14px;
  line-height: 1.7;
}

.loading-text {
  margin: 14px 0 0;
}

.answer {
  margin-top: 18px;
  padding: 16px;
  background: var(--color-surface-muted);
  border-radius: var(--radius-md);
}

.answer-header {
  color: var(--color-text-muted);
  font-size: 12px;
}

.answer-header strong {
  color: var(--color-accent);
  font-size: 13px;
}

.reply {
  margin: 12px 0 0;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.usage {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin: 16px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}

.usage div {
  display: flex;
  gap: 6px;
  font-size: 12px;
}

.usage dt {
  color: var(--color-text-muted);
}

.usage dd {
  margin: 0;
  font-weight: 600;
}

@media (max-width: 560px) {
  .form-footer {
    align-items: flex-end;
  }

  .usage {
    display: grid;
    gap: 6px;
  }
}
</style>
