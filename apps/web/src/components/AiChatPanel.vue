<script setup lang="ts">
import { computed, ref } from 'vue';
import { streamChat, type ChatStreamMeta } from '@/api/chat-stream';
import { useAuthStore } from '@/stores/auth';

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
const reply = ref('');
const meta = ref<ChatStreamMeta | null>(null);
const loading = ref(false);
const errorMessage = ref('');
const lastRequest = ref<{ message: string; template: PromptTemplateId } | null>(null);
/** 当前流的中断句柄；停止生成或组件卸载时调用 abort。 */
let controller: AbortController | null = null;

const activeTemplate = computed(
  () => templates.find((item) => item.id === template.value) ?? templates[0],
);

function templateName(id: string): string {
  return templates.find((item) => item.id === id)?.name ?? id;
}

const canSubmit = computed(
  () =>
    auth.isAuthenticated &&
    !loading.value &&
    message.value.trim().length > 0 &&
    message.value.length <= 8000,
);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function runChat(text: string, templateId: PromptTemplateId): Promise<void> {
  const trimmed = text.trim();
  if (!auth.isAuthenticated || loading.value || !trimmed) return;

  lastRequest.value = { message: trimmed, template: templateId };
  reply.value = '';
  meta.value = null;
  errorMessage.value = '';
  loading.value = true;
  controller = new AbortController();

  try {
    await streamChat({
      message: trimmed,
      template: templateId,
      token: auth.accessToken,
      signal: controller.signal,
      onDelta: (chunk) => {
        reply.value += chunk;
      },
      onMeta: (value) => {
        meta.value = value;
      },
      refreshToken: () => auth.refreshAccessToken(),
    });
  } catch (error) {
    // 用户主动停止不算失败：保留已生成内容，不弹错误。
    if (!isAbortError(error) && !controller.signal.aborted) {
      errorMessage.value = error instanceof Error ? error.message : '流式请求失败，请稍后重试';
    }
  } finally {
    loading.value = false;
    controller = null;
  }
}

function submitMessage(): void {
  void runChat(message.value, template.value);
}

function stopGenerating(): void {
  controller?.abort();
}

function regenerate(): void {
  if (lastRequest.value) {
    void runChat(lastRequest.value.message, lastRequest.value.template);
  }
}
</script>

<template>
  <!-- eslint-disable vue/max-attributes-per-line, vue/singleline-html-element-content-newline -->
  <section class="chat-panel" aria-labelledby="deepseek-chat-title">
    <header class="chat-header">
      <div>
        <p class="eyebrow">Week 03 · Day 05</p>
        <h2 id="deepseek-chat-title">DeepSeek 流式对话</h2>
      </div>
      <span class="tag">单轮 · SSE 流式</span>
    </header>

    <p class="description">
      回复会逐段出现；可随时停止生成，停止后上游模型请求也会被取消，不再继续计费。
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
        <div class="form-actions">
          <button v-if="loading" class="button" type="button" @click="stopGenerating">
            停止生成
          </button>
          <button class="button primary" type="submit" :disabled="!canSubmit">
            {{ loading ? '生成中…' : `用「${activeTemplate.name}」发送` }}
          </button>
        </div>
      </div>
    </form>

    <p v-if="errorMessage" class="error-text" role="alert">
      {{ errorMessage }}
    </p>

    <p v-else-if="loading && !reply" class="loading-text" role="status">正在等待第一个 Token…</p>

    <article v-if="reply || meta" class="answer" aria-live="polite">
      <div class="answer-header">
        <strong>{{ templateName(meta?.template ?? template) }} · Assistant</strong>
        <span>{{ meta?.model ?? 'streaming' }}</span>
      </div>
      <p class="reply">{{ reply }}<span v-if="loading" class="caret" aria-hidden="true" /></p>
      <dl v-if="meta?.usage" class="usage">
        <div>
          <dt>输入 Token</dt>
          <dd>{{ meta.usage.promptTokens }}</dd>
        </div>
        <div>
          <dt>输出 Token</dt>
          <dd>{{ meta.usage.completionTokens }}</dd>
        </div>
        <div>
          <dt>合计</dt>
          <dd>{{ meta.usage.totalTokens }}</dd>
        </div>
      </dl>
      <div v-if="!loading" class="answer-actions">
        <button class="button" type="button" @click="regenerate">重新生成</button>
      </div>
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

.form-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: var(--color-accent);
  animation: caret-blink 1s steps(2, start) infinite;
}

@keyframes caret-blink {
  to {
    visibility: hidden;
  }
}

.answer-actions {
  margin-top: 14px;
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
