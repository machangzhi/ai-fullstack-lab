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
  template: PromptTemplateId;
}

/** 与 ai-core 的 PROMPT_TEMPLATE_IDS 保持一致；ID 是协议，文案可以随时改。 */
type PromptTemplateId = 'assistant' | 'support' | 'summary' | 'classify';

const templates: ReadonlyArray<{
  id: PromptTemplateId;
  name: string;
  description: string;
  example: string;
}> = [
  {
    id: 'assistant',
    name: '通用助手',
    description: '沿用 Day 2 的学习助手，回答技术问题。',
    example: '例如：用三句话解释 system、user 和 assistant 的区别',
  },
  {
    id: 'support',
    name: '客服助手',
    description: '处理课程购买、账号、退款咨询，需要人工时不擅自承诺。',
    example: '例如：我买的课一直白屏打不开，能退款吗？',
  },
  {
    id: 'summary',
    name: '摘要助手',
    description: '把长文压缩为一句话摘要加不超过三条要点。',
    example: '把一段课程公告或会议记录粘贴到这里，模板会压缩成摘要',
  },
  {
    id: 'classify',
    name: '分类助手',
    description: '把用户反馈归入固定类别，输出严格 JSON。',
    example: '例如：申请退款三天了还没到账，客服也不回复',
  },
];

const auth = useAuthStore();
const message = ref('');
const template = ref<PromptTemplateId>('assistant');
const result = ref<ChatReply | null>(null);
const loading = ref(false);
const errorMessage = ref('');

const activeTemplate = computed(
  () => templates.find((item) => item.id === template.value) ?? templates[0],
);

function templateName(id: PromptTemplateId): string {
  return templates.find((item) => item.id === id)?.name ?? id;
}

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
      { message: message.value.trim(), template: template.value },
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
        <p class="eyebrow">Week 03 · Day 03</p>
        <h2 id="deepseek-chat-title">Prompt 模板对比</h2>
      </div>
      <span class="tag">单轮 · 非流式</span>
    </header>

    <p class="description">
      同一个问题可以切换不同模板；模板与 API Key 都在服务端，浏览器只提交模板 ID。
    </p>

    <div class="template-picker">
      <label for="chat-template">Prompt 模板</label>
      <select id="chat-template" v-model="template" :disabled="loading || !auth.isAuthenticated">
        <option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <p class="template-hint">{{ activeTemplate.description }}</p>
    </div>

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
        :placeholder="activeTemplate.example"
      />
      <div class="form-footer">
        <span class="character-count">{{ message.length }} / 8000</span>
        <button class="button primary" type="submit" :disabled="!canSubmit">
          {{ loading ? '等待 DeepSeek 回复…' : `用「${activeTemplate.name}」发送` }}
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
        <strong>{{ templateName(result.template) }} · Assistant</strong>
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

.template-picker {
  display: grid;
  gap: 6px;
  margin-bottom: 16px;
}

.template-picker label {
  font-size: 14px;
  font-weight: 600;
}

.template-picker select {
  width: 100%;
  padding: 9px 12px;
  color: var(--color-text);
  font: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
}

.template-picker select:focus {
  border-color: var(--color-accent);
  outline: 3px solid rgba(79, 70, 229, 0.12);
}

.template-picker select:disabled {
  background: var(--color-surface-muted);
  cursor: not-allowed;
}

.template-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.6;
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
