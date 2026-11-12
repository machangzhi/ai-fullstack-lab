<!--
  文件作用：首页 HomeView.vue，展示 API 状态、运行配置、阶段进度和本地启动命令。
  关键概念：
  1. <script setup lang="ts"> —— 组合式 API，ref 定义响应式状态，onMounted 在组件挂载后执行。
  2. ref<T>(null) —— 定义响应式引用，模板中直接用 health.value 的简写 health。
  3. Promise.all —— 并行请求 /health 和 /config，比串行 await 更快。
  4. try/catch/finally —— 请求成功设数据，失败设错误信息，最后关 loading。
  5. 模板中的 v-if / v-else-if / v-else —— 根据状态渲染不同内容（加载中/错误/数据）。
  6. :class 动态绑定 —— 根据 health 和 errorMessage 的值切换标签样式（ok/error/idle）。
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiGet } from '@/api/client';

// 与后端 HealthStatus 结构保持一致（第 1 周前端自己定义，第 3 周可抽成共享类型包）。
interface HealthStatus {
  status: string;
  uptime: number;
  version: string;
  timestamp: string;
}

// 与后端 RuntimeConfig 结构保持一致。
interface RuntimeConfig {
  appName: string;
  env: string;
  version: string;
  modelProvider: string;
  features: {
    chat: boolean;
    rag: boolean;
    agent: boolean;
  };
}

// 阶段进度项：state 控制 timeline 上的样式（done/current/todo）。
interface Milestone {
  week: string;
  title: string;
  state: 'done' | 'current' | 'todo';
}

// 响应式状态：health/config 数据、loading、错误信息。
const health = ref<HealthStatus | null>(null);
const runtimeConfig = ref<RuntimeConfig | null>(null);
const loading = ref(true);
const errorMessage = ref('');

// 16 周计划的阶段划分，第 1-2 周标记为 current。
const milestones: Milestone[] = [
  { week: '第 1～2 周', title: '工程环境与全栈基础', state: 'current' },
  { week: '第 3～4 周', title: '模型接入、SSE 与 AI Chat v1.0', state: 'todo' },
  { week: '第 5～7 周', title: '企业 RAG 知识库', state: 'todo' },
  { week: '第 8～12 周', title: 'Agent、LangGraph 与 MCP', state: 'todo' },
  { week: '第 13 周', title: 'AI Coding Agent', state: 'todo' },
  { week: '第 14～16 周', title: '部署上线与作品集', state: 'todo' },
];

// 加载服务状态：并行请求 health 和 config。
async function loadStatus(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';

  try {
    // Promise.all 并行请求，两个接口都返回后才继续。
    const [healthData, configData] = await Promise.all([
      apiGet<HealthStatus>('/health'),
      apiGet<RuntimeConfig>('/config'),
    ]);
    health.value = healthData;
    runtimeConfig.value = configData;
  } catch (error) {
    // 错误来自 ApiClientError，取 message；非 Error 类型兜底文案。
    errorMessage.value = error instanceof Error ? error.message : '无法连接 API 服务';
  } finally {
    loading.value = false;
  }
}

// 功能开关的中文标签。
function featureLabel(enabled: boolean): string {
  return enabled ? '已接入' : '待开发';
}

// 组件挂载后自动加载一次状态。
onMounted(loadStatus);
</script>

<template>
  <!-- Hero 区：标题、描述、操作按钮 -->
  <section class="hero">
    <p class="eyebrow">
      Week 01 · 环境与项目初始化
    </p>
    <h1>AI 应用全栈开发工作台</h1>
    <p class="hero-desc">
      一个可运行的 pnpm monorepo：Vue3 前端 + NestJS 后端，统一响应结构、请求 ID、参数校验与
      Swagger 文档。后续按 16 周计划逐步接入模型、RAG 与 Agent。
    </p>
    <div class="hero-actions">
      <!-- 刷新按钮：loading 时禁用，防止重复请求 -->
      <button
        class="button primary"
        type="button"
        :disabled="loading"
        @click="loadStatus"
      >
        {{ loading ? '检测中…' : '刷新服务状态' }}
      </button>
      <a
        class="button ghost"
        href="http://localhost:9527/docs"
        target="_blank"
        rel="noreferrer"
      >
        打开 Swagger
      </a>
    </div>
  </section>

  <!-- 状态卡片网格：API 状态 + 运行配置 -->
  <section class="status-grid">
    <article class="card">
      <header class="card-header">
        <h2>API 状态</h2>
        <!-- 标签样式根据状态动态切换 -->
        <span
          class="tag"
          :class="health ? 'ok' : errorMessage ? 'error' : 'idle'"
        >
          {{ health ? '在线' : errorMessage ? '离线' : '检测中' }}
        </span>
      </header>

      <!-- 错误态：显示错误信息 -->
      <p
        v-if="errorMessage"
        class="error-text"
      >
        {{ errorMessage }}
      </p>

      <!-- 成功态：显示健康检查数据 -->
      <dl
        v-else-if="health"
        class="kv"
      >
        <div>
          <dt>状态</dt>
          <dd>{{ health.status }}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>{{ health.version }}</dd>
        </div>
        <div>
          <dt>运行时长</dt>
          <dd>{{ health.uptime }} 秒</dd>
        </div>
        <div>
          <dt>检查时间</dt>
          <dd>{{ new Date(health.timestamp).toLocaleString() }}</dd>
        </div>
      </dl>

      <!-- 加载态 -->
      <p
        v-else
        class="muted"
      >
        正在请求 /api/health …
      </p>
    </article>

    <article class="card">
      <header class="card-header">
        <h2>运行配置</h2>
        <span class="tag neutral">公开信息</span>
      </header>

      <dl
        v-if="runtimeConfig"
        class="kv"
      >
        <div>
          <dt>应用</dt>
          <dd>{{ runtimeConfig.appName }}</dd>
        </div>
        <div>
          <dt>环境</dt>
          <dd>{{ runtimeConfig.env }}</dd>
        </div>
        <div>
          <dt>模型供应商</dt>
          <dd>{{ runtimeConfig.modelProvider }}</dd>
        </div>
        <div>
          <dt>AI 能力</dt>
          <dd>
            对话 {{ featureLabel(runtimeConfig.features.chat) }} · 检索
            {{ featureLabel(runtimeConfig.features.rag) }} · Agent
            {{ featureLabel(runtimeConfig.features.agent) }}
          </dd>
        </div>
      </dl>

      <p
        v-else
        class="muted"
      >
        正在请求 /api/config …
      </p>
    </article>
  </section>

  <!-- 阶段进度时间线 -->
  <section class="card roadmap">
    <header class="card-header">
      <h2>阶段进度</h2>
      <span class="tag neutral">第 1 周进行中</span>
    </header>
    <ol class="timeline">
      <!-- v-for 遍历 milestones，:key 用唯一标识 -->
      <li
        v-for="item in milestones"
        :key="item.title"
        :class="item.state"
      >
        <span
          class="dot"
          aria-hidden="true"
        />
        <div>
          <strong>{{ item.title }}</strong>
          <small>{{ item.week }}</small>
        </div>
      </li>
    </ol>
  </section>

  <!-- 本地启动命令 -->
  <section class="card quickstart">
    <header class="card-header">
      <h2>本地启动</h2>
    </header>
    <pre><code>pnpm install
pnpm dev        # 同时启动 web(5173) 与 api(9527)
pnpm build      # 构建全部应用
pnpm lint       # 代码检查</code></pre>
    <p class="muted">
      服务端配置见 <code>apps/api/.env.example</code>，前端配置见
      <code>apps/web/.env.example</code>；密钥只允许放在服务端环境变量中。
    </p>
  </section>
</template>

<style scoped>
/* scoped 表示样式只作用于当前组件，不会污染全局。 */

.hero {
  padding: 8px 0 4px;
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-accent);
}

.hero h1 {
  margin: 0;
  font-size: clamp(26px, 3.4vw, 38px);
  line-height: 1.25;
  letter-spacing: -0.02em;
}

.hero-desc {
  max-width: 720px;
  margin: 12px 0 0;
  color: var(--color-text-muted);
  line-height: 1.75;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 20px;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.card {
  padding: 20px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header h2 {
  margin: 0;
  font-size: 16px;
}

.tag {
  padding: 3px 9px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid transparent;
}

.tag.ok {
  color: #0f7b4f;
  background: #e6f7ef;
  border-color: #b9e8d2;
}

.tag.error {
  color: #a32222;
  background: #fdecec;
  border-color: #f6c9c9;
}

.tag.idle,
.tag.neutral {
  color: var(--color-text-muted);
  background: var(--color-surface-muted);
  border-color: var(--color-border);
}

.kv {
  display: grid;
  gap: 10px;
  margin: 0;
}

.kv div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 14px;
}

.kv dt {
  color: var(--color-text-muted);
}

.kv dd {
  margin: 0;
  font-weight: 600;
  text-align: right;
}

.muted {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1.7;
}

.error-text {
  margin: 0;
  color: #a32222;
  font-size: 14px;
  line-height: 1.7;
}

.timeline {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.timeline li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.timeline .dot {
  width: 10px;
  height: 10px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--color-border-strong);
  flex: 0 0 auto;
}

.timeline li.current .dot {
  background: var(--color-accent);
  box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.14);
}

.timeline li.done .dot {
  background: #0f7b4f;
}

.timeline div {
  display: grid;
  gap: 2px;
}

.timeline strong {
  font-size: 14px;
}

.timeline small {
  color: var(--color-text-muted);
  font-size: 12px;
}

.quickstart pre {
  margin: 0 0 12px;
  padding: 14px 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.7;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: var(--radius-md);
}

.quickstart code {
  font-family: var(--font-mono);
}
</style>
