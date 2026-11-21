<!--
  文件作用：AI Chat MVP 页面（Week 3 Day 6）。

  结构：
  - 左侧：会话列表 + 新建对话
  - 右侧：历史消息 + 流式回复 + 输入框

  关键点：
  1. 历史只来自 /conversations/:id/messages，服务端已做归属校验，前端不需要也不应该自己拼 userId。
  2. 发送时先插入一条本地用户气泡和一条空的助手气泡，随后由 SSE 增量填充；
     服务端 meta 到达后再重新拉取消息，把本地临时数据换成数据库里的真实记录。
  3. 用户停止生成时，已生成的文字留在页面上，但不会落库（下一次进来不会出现半截回答）。
-->

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { apiGet, apiPost } from '@/api/client';
import { streamChat } from '@/api/chat-stream';
import { useAuthStore } from '@/stores/auth';

interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface MessageItem {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
  content: string;
  tokens: number;
  createdAt: string;
}

interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface UsageSummary {
  today: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface ModelProfile {
  id: string;
  label: string;
  provider: string;
  model: string;
}

interface ModelCatalog {
  defaultId: string;
  models: ModelProfile[];
}

const auth = useAuthStore();

const conversations = ref<ConversationSummary[]>([]);
const activeId = ref('');
const messages = ref<MessageItem[]>([]);
const draft = ref('');
const replying = ref(false);
const loadingList = ref(false);
const loadingMessages = ref(false);
const errorMessage = ref('');
const notice = ref('');
const usage = ref<UsageSummary | null>(null);
const models = ref<ModelProfile[]>([]);
const selectedModel = ref('');

let controller: AbortController | null = null;
const threadRef = ref<HTMLElement | null>(null);

const activeConversation = computed(
  () => conversations.value.find((item) => item.id === activeId.value) ?? null,
);

const activeModelLabel = computed(() => {
  const current = models.value.find((item) => item.id === selectedModel.value);
  return current?.label ?? current?.model ?? '默认模型';
});

const canSend = computed(
  () => !replying.value && draft.value.trim().length > 0 && draft.value.length <= 8000,
);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (threadRef.value) {
    threadRef.value.scrollTop = threadRef.value.scrollHeight;
  }
}

async function loadConversations(): Promise<void> {
  loadingList.value = true;
  try {
    const page = await apiGet<Paginated<ConversationSummary>>('/conversations?pageSize=50');
    conversations.value = page.items;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载会话失败';
  } finally {
    loadingList.value = false;
  }
}

async function loadUsage(): Promise<void> {
  try {
    usage.value = await apiGet<UsageSummary>('/ai/usage');
  } catch {
    // 用量是辅助信息，失败不打断聊天。
    usage.value = null;
  }
}

/** 模型目录来自服务端配置，前端只拿公开别名；失败时退回默认模型。 */
async function loadModels(): Promise<void> {
  try {
    const catalog = await apiGet<ModelCatalog>('/ai/models');
    models.value = catalog.models;
    if (!models.value.some((item) => item.id === selectedModel.value)) {
      selectedModel.value = catalog.defaultId;
    }
  } catch {
    models.value = [];
    selectedModel.value = '';
  }
}

async function loadMessages(conversationId: string): Promise<void> {
  loadingMessages.value = true;
  errorMessage.value = '';
  try {
    const page = await apiGet<Paginated<MessageItem>>(
      `/conversations/${conversationId}/messages?pageSize=100`,
    );
    messages.value = page.items;
    await scrollToBottom();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载历史消息失败';
  } finally {
    loadingMessages.value = false;
  }
}

async function selectConversation(conversationId: string): Promise<void> {
  if (replying.value || conversationId === activeId.value) return;
  activeId.value = conversationId;
  notice.value = '';
  await loadMessages(conversationId);
}

async function createConversation(): Promise<void> {
  if (replying.value) return;
  errorMessage.value = '';
  try {
    const created = await apiPost<ConversationSummary>('/conversations', {});
    conversations.value = [created, ...conversations.value];
    activeId.value = created.id;
    messages.value = [];
    notice.value = '新对话已创建，发送第一条消息后会生成标题。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建会话失败';
  }
}

async function sendMessage(): Promise<void> {
  if (!canSend.value) return;

  if (!activeId.value) {
    await createConversation();
    if (!activeId.value) return;
  }

  const content = draft.value.trim();
  const conversationId = activeId.value;
  draft.value = '';
  errorMessage.value = '';
  notice.value = '';
  replying.value = true;
  controller = new AbortController();

  messages.value.push({
    id: `local-user-${Date.now()}`,
    role: 'USER',
    content,
    tokens: 0,
    createdAt: new Date().toISOString(),
  });
  const assistantMessage: MessageItem = {
    id: `local-assistant-${Date.now()}`,
    role: 'ASSISTANT',
    content: '',
    tokens: 0,
    createdAt: new Date().toISOString(),
  };
  messages.value.push(assistantMessage);
  await scrollToBottom();

  try {
    await streamChat({
      message: content,
      template: 'assistant',
      model: selectedModel.value || undefined,
      conversationId,
      token: auth.accessToken,
      signal: controller.signal,
      refreshToken: () => auth.refreshAccessToken(),
      onDelta: (chunk) => {
        assistantMessage.content += chunk;
        void scrollToBottom();
      },
      onMeta: (meta) => {
        assistantMessage.tokens = meta.usage?.totalTokens ?? 0;
        const current = conversations.value.find((item) => item.id === conversationId);
        if (current && meta.title) {
          current.title = meta.title;
        }
      },
    });

    // 用数据库记录替换本地临时气泡，确保 id 与时间来自服务端。
    await loadMessages(conversationId);
    await loadConversations();
    await loadUsage();
  } catch (error) {
    if (isAbortError(error) || controller?.signal.aborted) {
      notice.value = '已停止生成：本次回复未保存，重新发送即可继续。';
    } else {
      errorMessage.value = error instanceof Error ? error.message : '发送失败，请稍后重试';
      // 失败时保留用户输入已插入的气泡，但移除空的助手气泡。
      messages.value = messages.value.filter((item) => item.id !== assistantMessage.id);
    }
  } finally {
    replying.value = false;
    controller = null;
    await scrollToBottom();
  }
}

function stopGenerating(): void {
  controller?.abort();
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

onMounted(async () => {
  await loadModels();
  await loadConversations();
  await loadUsage();
  const first = conversations.value[0];
  if (first) {
    activeId.value = first.id;
    await loadMessages(first.id);
  }
});

onUnmounted(() => controller?.abort());
</script>

<template>
  <section class="chat-page">
    <aside class="conversation-panel">
      <header class="panel-header">
        <div>
          <p class="eyebrow">Week 04 · Day 01</p>
          <h1>AI Chat</h1>
        </div>
        <button
          class="button primary"
          type="button"
          :disabled="replying"
          @click="createConversation"
        >
          新建对话
        </button>
      </header>

      <p v-if="loadingList" class="muted">正在加载会话…</p>
      <p v-else-if="conversations.length === 0" class="muted">还没有会话，点击「新建对话」开始。</p>
      <ul v-else class="conversation-list">
        <li v-for="item in conversations" :key="item.id">
          <button
            type="button"
            class="conversation-item"
            :class="{ active: item.id === activeId }"
            @click="selectConversation(item.id)"
          >
            <strong>{{ item.title }}</strong>
            <span>{{ item.messageCount }} 条消息 · {{ formatTime(item.updatedAt) }}</span>
          </button>
        </li>
      </ul>
    </aside>

    <section class="thread-panel">
      <header class="thread-header">
        <div>
          <h2>{{ activeConversation?.title ?? '选择或新建一个对话' }}</h2>
          <p class="muted">
            模型 {{ activeModelLabel }} · 今日 {{ usage?.today.requests ?? 0 }} 次调用 ·
            {{ usage?.today.totalTokens ?? 0 }} Tokens
          </p>
        </div>
        <span class="tag">多轮 · SSE 流式</span>
      </header>

      <div ref="threadRef" class="thread">
        <p v-if="loadingMessages" class="muted">正在加载历史消息…</p>
        <p v-else-if="messages.length === 0" class="muted">
          发送第一条消息开始对话。服务端会带上最近 20 条历史，超出预算时从最旧的消息开始丢弃。
        </p>

        <article
          v-for="item in messages"
          :key="item.id"
          class="bubble"
          :class="item.role === 'USER' ? 'from-user' : 'from-assistant'"
        >
          <div class="bubble-meta">
            <strong>{{ item.role === 'USER' ? '我' : 'Assistant' }}</strong>
            <span v-if="item.tokens > 0">{{ item.tokens }} Tokens</span>
          </div>
          <p class="bubble-content">
            {{ item.content
            }}<span
              v-if="replying && item.role === 'ASSISTANT' && item.id.startsWith('local-assistant')"
              class="caret"
              aria-hidden="true"
            />
          </p>
        </article>
      </div>

      <p v-if="errorMessage" class="error-text" role="alert">
        {{ errorMessage }}
      </p>
      <p v-else-if="notice" class="notice-text" role="status">
        {{ notice }}
      </p>

      <p v-if="!auth.isAuthenticated" class="muted login-hint">
        <RouterLink to="/login">登录</RouterLink> 后才能发送消息。
      </p>

      <form v-else class="composer" @submit.prevent="sendMessage">
        <textarea
          v-model="draft"
          rows="3"
          maxlength="8000"
          placeholder="输入问题，Enter 换行；点击发送后逐字输出。"
          :disabled="replying"
        />
        <div class="composer-footer">
          <span class="muted">{{ draft.length }} / 8000</span>
          <div class="composer-actions">
            <label v-if="models.length > 1" class="model-picker">
              模型
              <select v-model="selectedModel" :disabled="replying">
                <option v-for="item in models" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <button v-if="replying" class="button" type="button" @click="stopGenerating">
              停止生成
            </button>
            <button class="button primary" type="submit" :disabled="!canSend">
              {{ replying ? '生成中…' : '发送' }}
            </button>
          </div>
        </div>
      </form>
    </section>
  </section>
</template>

<style scoped>
.chat-page {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.conversation-panel,
.thread-panel {
  padding: 20px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.conversation-panel {
  position: sticky;
  top: 16px;
}

.panel-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.panel-header h1 {
  margin: 0;
  font-size: 20px;
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-accent);
}

.conversation-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 60vh;
  overflow-y: auto;
}

.conversation-item {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.conversation-item:hover {
  border-color: var(--color-border);
  background: var(--color-surface-muted);
}

.conversation-item.active {
  border-color: var(--color-accent);
  background: rgba(79, 70, 229, 0.08);
}

.conversation-item span {
  color: var(--color-text-muted);
  font-size: 12px;
}

.thread-panel {
  display: flex;
  flex-direction: column;
  min-height: 60vh;
}

.thread-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.thread-header h2 {
  margin: 0 0 4px;
  font-size: 16px;
}

.tag {
  padding: 3px 9px;
  font-size: 12px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  white-space: nowrap;
}

.thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 240px;
  max-height: 55vh;
  overflow-y: auto;
  padding: 4px;
}

.bubble {
  padding: 12px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-surface-muted);
}

.bubble.from-user {
  align-self: flex-end;
  max-width: 80%;
  background: rgba(79, 70, 229, 0.08);
  border-color: rgba(79, 70, 229, 0.24);
}

.bubble.from-assistant {
  align-self: flex-start;
  max-width: 92%;
}

.bubble-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.bubble-content {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.7;
  word-break: break-word;
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

.composer {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.composer textarea {
  width: 100%;
  padding: 10px 12px;
  font: inherit;
  color: inherit;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  resize: vertical;
}

.composer textarea:focus {
  outline: 2px solid rgba(79, 70, 229, 0.35);
  outline-offset: 1px;
}

.composer-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.composer-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.model-picker {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  color: var(--color-text-muted);
}

.model-picker select {
  padding: 4px 8px;
  font: inherit;
  color: inherit;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.muted {
  color: var(--color-text-muted);
  font-size: 13px;
  line-height: 1.7;
  margin: 0;
}

.error-text {
  margin: 12px 0 0;
  color: #a32222;
  font-size: 14px;
}

.notice-text {
  margin: 12px 0 0;
  color: var(--color-text-muted);
  font-size: 14px;
}

.login-hint {
  margin-top: 12px;
}

@media (max-width: 860px) {
  .chat-page {
    grid-template-columns: 1fr;
  }

  .conversation-panel {
    position: static;
  }

  .conversation-list {
    max-height: 220px;
  }
}
</style>
