# apps/api

AI 全栈应用的后端服务，统一网关：鉴权、会话、模型调用、RAG 与 Agent 编排。

## 技术栈

- NestJS + TypeScript（Module / Controller / Provider / DTO / Pipe / Guard）
- PostgreSQL + Prisma + pgvector
- Swagger / OpenAPI 接口文档
- SSE 流式响应

## 模块划分（规划）

| 模块 | 职责 |
| --- | --- |
| health | 健康检查、版本信息 |
| auth | 注册、登录、JWT / Refresh Token、RBAC |
| users | 用户资料与配置 |
| conversations | 会话与消息持久化 |
| files | 受控文件上传、MIME 与大小校验、元数据 |
| ai | 模型调用、Prompt、结构化输出、用量记录 |
| rag | 知识库、切片、检索与问答 |
| agent | 工具调用、工作流执行、审批回调 |

## 约定

- 业务逻辑不写死在 Controller，模型能力通过 `packages/ai-core`、`packages/rag`、`packages/agent` 复用。
- 统一成功/失败响应结构，错误带请求 ID，便于日志追踪。
- 密钥只从服务端环境变量读取，仓库只提交 `.env.example`。
- 数据库变更走 Prisma Migration，不手改线上表结构。

## 开发任务清单

- [ ] 工程：NestJS 初始化、配置校验、Swagger、统一响应结构、请求 ID 与基础日志
- [ ] 数据：Prisma 建模 users/conversations/messages，完成迁移与数据访问层
- [ ] 鉴权：注册、登录、JWT Guard、Refresh Token、bcrypt/argon2 密码哈希
- [ ] 文件：受控上传接口，MIME 与大小校验，元数据入库
- [ ] AI：`POST /ai/chat`、SSE 流式、结构化输出接口、模型切换与用量日志
- [ ] RAG：ingestion 接口（上传/解析/切片/向量化/入库）、检索调试接口、`/knowledge/ask`
- [ ] 知识库：租户/知识库/文档/任务表，异步任务状态机，检索强制权限过滤
- [ ] Agent：工具调用、工作流执行、Checkpoint、审批回调、MCP Client
- [ ] 运维：结构化日志、耗时与 Token 统计、失败告警字段

## 验收标准

- [ ] `/health` 返回 200 并包含版本信息
- [ ] 受保护接口无 token 返回 401；越权访问他人知识库返回 403/404
- [ ] DTO 参数非法返回 400，错误信息可定位到字段
- [ ] 统一成功/失败响应稳定；错误响应含 requestId，可在日志中检索
- [ ] SSE 连接异常断开可释放资源，长回答可被中止
- [ ] 模型调用具备超时、有限重试、并发限制与统一错误码
- [ ] 全部接口在 Swagger 可见并可调试
- [ ] 日志与响应中不出现密钥、明文密码等敏感信息
