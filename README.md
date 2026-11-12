# ai-fullstack-lab

前端开发转 AI 应用全栈开发的 16 周学习仓库，对应《前端开发转 AI 应用全栈开发：16 周每日执行计划》。

## 技术主线

- 前端：Vue3 + Vite + TypeScript + Element Plus + Pinia
- 后端：Node.js + TypeScript + NestJS
- 数据：PostgreSQL + Prisma + pgvector
- AI：LangChain.js + LangGraph.js + MCP
- 工程：pnpm monorepo、Docker

## 目录结构

```text
ai-fullstack-lab/
├─ apps/          # 可运行应用
│  ├─ web/        # Vue3 + Vite + TypeScript
│  └─ api/        # NestJS + TypeScript
├─ packages/      # 可复用能力库
│  ├─ ai-core/    # 模型适配、Prompt、工具抽象
│  ├─ rag/        # 文档解析、切片、检索
│  └─ agent/      # LangGraph 工作流
├─ mcp-servers/   # 自建 MCP Server
├─ docs/          # 架构图、接口、复盘、面试材料
└─ infra/         # Docker、部署配置
```

## 阶段里程碑

| 阶段 | 周次 | 主要交付 |
| --- | --- | --- |
| 工程与全栈基础 | 第 1～2 周 | ai-fullstack-starter、登录/会话/文件上传的全栈基础应用 |
| 模型应用工程化 | 第 3～4 周 | AI Chat MVP、结构化输出与评估 |
| RAG 知识库 | 第 5～7 周 | 企业 RAG 知识库产品 |
| Agent 与 MCP | 第 8～12 周 | 工具 Agent、LangGraph Workflow、企业业务 Agent |
| AI Coding Agent | 第 13 周 | AI Coding Agent |
| 产品化与求职 | 第 14～16 周 | 部署上线、架构复盘、作品集与面试材料 |

## 本地启动

```bash
# 安装依赖（Node >= 20、pnpm 9）
pnpm install

# 同时启动 web(5173) 与 api(3000)
pnpm dev

# 构建 / 检查
pnpm build
pnpm lint
```

| 地址 | 说明 |
| --- | --- |
| http://localhost:5173 | Vue3 前端工作台 |
| http://localhost:3000/api | NestJS 接口前缀 |
| http://localhost:3000/api/health | 健康检查 |
| http://localhost:3000/docs | Swagger 文档 |

环境变量：复制 `apps/api/.env.example` 为 `apps/api/.env`、`apps/web/.env.example` 为 `apps/web/.env.local` 后按需修改。密钥只允许放在服务端环境变量中。

## 当前进度

- 第 1 周已完成：pnpm monorepo、Vue3 + Vite + TS 前端、NestJS 后端、统一响应结构与请求 ID、DTO 参数校验、Swagger、Prettier/ESLint、环境变量模板。
- 已通过 `pnpm build`、`pnpm lint` 与接口冒烟测试（`/api/health`、`/api/config`、`/api/users`、错误响应含 requestId）。

## 协作约定

- 每个子目录的职责与边界见各自的 `README.md`。
- 密钥只放在服务端环境变量中，仓库只提交 `.env.example`。
- 每天结束前写三行复盘：解决了什么问题、为什么这样设计、还有什么不确定。
- 每天必须有可检查的代码提交或学习产物。

## 开发任务清单

- [x] 第 1 周：初始化 pnpm workspace、ESLint/Prettier、路径别名、`.env.example`；交付 ai-fullstack-starter
- [ ] 第 2 周：users/conversations/messages 数据模型、Prisma Migration、JWT 鉴权、受控文件上传
- [ ] 第 3～4 周：模型接入、Prompt、结构化输出、SSE、工具调用、评估集；交付 AI Chat v1.0
- [ ] 第 5～7 周：解析 → 切片 → Embedding → pgvector 检索 → 引用回答；交付 Enterprise RAG v1
- [ ] 第 8～9 周：Tool Agent、LangGraph 工作流；第 10 周交付 MCP Tool Hub
- [ ] 第 11～12 周：业务 Agent（≥5 工具、3 类任务、审批、记忆）；交付 Enterprise Business Agent v1
- [ ] 第 13 周：Coding Agent（staged diff 审查、规则分级、patch 确认、白名单测试）
- [ ] 第 14 周：Docker Compose、CI、Nginx、日志与用量统计；交付可部署版本
- [ ] 第 15～16 周：质量打磨、安全审查、架构文档、作品集与面试材料

## 验收标准

- [ ] 11 个目录下均有职责明确的 README，任务清单与验收标准与 16 周计划对应
- [ ] 干净环境按 README 一条命令可启动 web + api + PostgreSQL(pgvector)
- [ ] 四个作品项目（AI Chat / 企业 RAG / 业务 Agent / Coding Agent）均可演示
- [ ] 每个 AI 模块有固定评估集：Prompt 20 条、RAG 30 条、Agent 30 条，并有指标记录
- [ ] 仓库无密钥、无 `.env` 文件，仅保留 `.env.example`
- [ ] 每周有可检查的 Git 提交与三行复盘
