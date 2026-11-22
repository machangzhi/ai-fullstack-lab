# AI Chat v1.0 API 文档

> 版本：1.0.0　更新日期：2026-11-21
>
> 在线文档：本地启动后访问 `http://localhost:9527/docs`（Swagger UI）。本文档记录契约、示例与错误码，Swagger 负责交互调试。

## 一、通用约定

| 项目 | 约定 |
| --- | --- |
| Base URL | 开发：`http://localhost:9527/api`；生产：`https://<host>/lab/api` |
| 内容类型 | JSON 请求使用 `application/json`；上传使用 `multipart/form-data`；流式响应为 `text/event-stream` |
| 鉴权 | `Authorization: Bearer <accessToken>` |
| 请求追踪 | 请求头 `x-request-id` 可选；服务端会复用或生成，并回写到响应头与响应体 |
| 时间格式 | ISO 8601 UTC 字符串 |
| 版本 | API 版本与产品版本一致：`1.0.0` |

### 1.1 成功响应

除 SSE 与 `204` 外，所有接口统一包装：

```json
{
  "success": true,
  "data": { "status": "ok" },
  "requestId": "7f1c2b9e-4b3a-4d7e-9c1a-2f0b8d6e5a41",
  "timestamp": "2026-11-21T08:00:00.000Z"
}
```

### 1.2 失败响应

```json
{
  "success": false,
  "error": {
    "code": "AI_TIMEOUT",
    "message": "模型响应超时，请稍后重试。",
    "details": null
  },
  "requestId": "7f1c2b9e-4b3a-4d7e-9c1a-2f0b8d6e5a41",
  "timestamp": "2026-11-21T08:00:00.000Z"
}
```

前端应只按 `error.code` 分支，`message` 仅用于展示。校验失败时 `details` 包含字段级原因。

## 二、接口总览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/register` | 否 | 注册并返回令牌对 |
| POST | `/auth/login` | 否 | 登录；连续失败 5 次锁定 15 分钟 |
| POST | `/auth/refresh` | 否 | 刷新令牌（轮换，旧 refresh 立即失效） |
| POST | `/auth/logout` | 是 | 登出，使 refresh token 失效 |
| GET | `/auth/me` | 是 | 当前用户 |
| GET | `/users` | ADMIN | 用户分页列表 |
| GET | `/users/:id` | 是 | 用户详情 |
| POST | `/users` | ADMIN | 管理端创建用户 |
| POST | `/files/upload` | 是 | 上传文件（≤5MB，类型白名单） |
| GET | `/ai/models` | 是 | 可切换模型档案（不含地址与密钥） |
| GET | `/ai/usage` | 是 | 今日用量与最近 10 次调用 |
| POST | `/ai/chat` | 是 | 单轮非流式对话 |
| POST | `/ai/chat/stream` | 是 | 单轮流式对话（SSE） |
| POST | `/ai/tools/chat` | 是 | 工具调用（时间 / 计算器） |
| POST | `/ai/classify` | 是 | 反馈分类，Zod 校验 |
| POST | `/ai/extract` | 是 | 实体抽取，Zod 校验 |
| POST | `/conversations` | 是 | 创建会话 |
| GET | `/conversations` | 是 | 我的会话列表 |
| GET | `/conversations/:id` | 是 | 会话详情（归属校验） |
| GET | `/conversations/:id/messages` | 是 | 会话消息（升序分页） |
| POST | `/conversations/:id/messages` | 是 | 追加一条用户消息 |
| POST | `/conversations/:id/messages/stream` | 是 | 多轮流式对话（保存历史与用量） |
| GET | `/health` | 否 | 健康检查 |
| GET | `/config` | 否 | 可公开的运行配置 |

## 三、鉴权

### 3.1 注册

`POST /api/auth/register`

```json
{
  "email": "alice@example.com",
  "name": "Alice",
  "password": "P@ssw0rd123"
}
```

约束：邮箱合法且唯一；昵称 2–32 字符；密码 8–64 位且同时包含字母和数字。

响应 `data`：

```json
{
  "user": { "id": "clx...", "email": "alice@example.com", "name": "Alice", "role": "MEMBER" },
  "tokens": { "accessToken": "eyJ...", "refreshToken": "d9f..." }
}
```

### 3.2 登录

`POST /api/auth/login`，请求体为 `email` + `password`，响应结构同上。失败 5 次后返回 `429 RATE_LIMITED`。

### 3.3 刷新与登出

- `POST /api/auth/refresh`：`{ "refreshToken": "d9f..." }`，返回新的令牌对；旧 refresh 立即失效。
- `POST /api/auth/logout`：需要 Bearer Token，成功返回 `204`，刷新能力立即失效。

### 3.4 当前用户

`GET /api/auth/me`，返回 `{ id, email, name, role, createdAt }`。

## 四、AI 对话

### 4.1 模型目录

`GET /api/ai/models`

```json
{
  "defaultId": "deepseek-chat",
  "models": [
    {
      "id": "deepseek-chat",
      "label": "DeepSeek Chat",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "contextWindow": 65536,
      "streaming": true
    }
  ]
}
```

客户端只能提交 `id`，不能提交地址、真实模型名或密钥。

### 4.2 单轮对话

`POST /api/ai/chat`

```json
{
  "message": "用三句话解释 system、user 和 assistant 的区别",
  "template": "assistant",
  "model": "deepseek-chat"
}
```

- `template` 可选：`assistant` / `support` / `summary` / `classify`，默认 `assistant`。
- `message` 必填，1–8000 字符，不能只含空白。
- `model` 可选，必须是 `GET /ai/models` 返回的档案 ID。

响应 `data`：

```json
{
  "reply": "system 定义模型的身份与约束……",
  "model": "deepseek-chat",
  "modelId": "deepseek-chat",
  "usage": { "promptTokens": 120, "completionTokens": 180, "totalTokens": 300 },
  "template": "assistant"
}
```

### 4.3 单轮流式（SSE）

`POST /api/ai/chat/stream`，请求体同上。

```bash
curl -N -X POST http://localhost:9527/api/ai/chat/stream \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"讲一个关于缓存的类比","template":"assistant"}'
```

事件格式：

```text
event: delta
data: {"type":"delta","content":"缓存"}

event: delta
data: {"type":"delta","content":"就像"}

event: meta
data: {"type":"meta","modelId":"deepseek-chat","model":"deepseek-chat","template":"assistant","usage":{"promptTokens":88,"completionTokens":120,"totalTokens":208}}
```

错误发生在响应头发出之后时，通过 `event: error` 下发：

```text
event: error
data: {"code":"AI_TIMEOUT","message":"模型响应超时，请稍后重试。"}
```

### 4.4 工具调用

`POST /api/ai/tools/chat`

```json
{ "message": "现在北京时间几点？顺便算一下 128 乘 37", "model": "deepseek-chat" }
```

响应 `data`：

```json
{
  "reply": "现在是北京时间 ……，128 × 37 = 4736。",
  "modelId": "deepseek-chat",
  "model": "deepseek-chat",
  "rounds": 2,
  "usage": { "promptTokens": 420, "completionTokens": 160, "totalTokens": 580 },
  "toolRuns": [
    {
      "round": 1,
      "id": "call_1",
      "name": "get_current_time",
      "arguments": "{\"timezone\":\"Asia/Shanghai\"}",
      "ok": true,
      "output": { "iso": "2026-11-21T16:00:00+08:00" },
      "durationMs": 12
    }
  ]
}
```

- 可用工具：`get_current_time`、`calculator`。
- 最多 4 轮；未登记工具或参数不合法会以工具错误回传给模型，由模型自行修正。
- `rounds` 是实际模型调用轮次，`usage` 为累计值。

### 4.5 结构化输出

`POST /api/ai/classify`

```json
{ "text": "申请退款三天了还没到账，客服也不回复" }
```

```json
{
  "data": {
    "category": "售后服务",
    "confidence": 0.92,
    "reason": "退款到账延迟属于售后处理范围"
  },
  "model": "deepseek-chat",
  "usage": { "promptTokens": 210, "completionTokens": 60, "totalTokens": 270 },
  "attempts": 1
}
```

`POST /api/ai/extract` 返回 `data.entities[]`。两者都通过 Zod 校验；首次解析失败会带着失败原因重试一次，仍失败返回 `502 AI_INVALID_OUTPUT`。

### 4.6 用量

`GET /api/ai/usage`

```json
{
  "today": { "requests": 12, "promptTokens": 3200, "completionTokens": 4100, "totalTokens": 7300 },
  "recent": [
    {
      "id": "clx...",
      "model": "deepseek-chat",
      "template": "assistant",
      "totalTokens": 420,
      "latencyMs": 1830,
      "createdAt": "2026-11-21T07:59:00.000Z"
    }
  ]
}
```

## 五、会话与消息

| 操作 | 请求 | 关键约束 |
| --- | --- | --- |
| 创建会话 | `POST /conversations` `{ title? }` | 标题 1–80 字符，默认「新对话」 |
| 会话列表 | `GET /conversations?page=1&pageSize=20` | 按 `updatedAt` 倒序，仅返回本人 |
| 会话详情 | `GET /conversations/:id` | 非本人返回 404，避免泄露存在性 |
| 消息列表 | `GET /conversations/:id/messages?page=1&pageSize=50` | `pageSize` 最大 100，按时间升序 |
| 追加消息 | `POST /conversations/:id/messages` `{ content }` | role 固定为 USER，1–8000 字符 |
| 多轮流式 | `POST /conversations/:id/messages/stream` `{ message, template?, model? }` | 保存历史与用量，meta 含 `conversationId`、`title` |

多轮流式的事件与单轮一致，`meta` 额外字段：

```json
{
  "type": "meta",
  "modelId": "deepseek-chat",
  "model": "deepseek-chat",
  "template": "assistant",
  "usage": { "promptTokens": 900, "completionTokens": 260, "totalTokens": 1160 },
  "conversationId": "clx...",
  "title": "关于 Prisma 的问题"
}
```

会话行为：

- 发送前先做归属校验，历史只能来自当前会话。
- 上下文按模型窗口裁剪，较早的消息会增量压缩为摘要；摘要失败降级为原文裁剪，不阻断聊天。
- 客户端中断后，已生成的半截回复不落库。

## 六、文件、健康检查与配置

### 6.1 上传文件

`POST /api/files/upload`，`multipart/form-data`，字段名 `file`。

- 允许：`image/png`、`image/jpeg`、`image/webp`、`application/pdf`、`text/plain`、`text/markdown`。
- 大小上限 5MB；文件名由服务端生成 UUID，扩展名由 MIME 白名单决定。
- 响应：`{ id, originalName, size, mimeType, storedName, ext }`。

### 6.2 健康检查

`GET /api/health` → `{ status, uptime, version, timestamp }`。`version` 来自 `APP_VERSION`，v1.0.0 为 `1.0.0`。

### 6.3 公开配置

`GET /api/config` → `{ appName, env, version, modelProvider, modelName, features }`。不包含任何密钥。

## 七、错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | DTO 校验失败、参数缺失 |
| 400 | `AI_MODEL_UNKNOWN` | 提交了不存在的模型档案 ID |
| 401 | `UNAUTHORIZED` | 未登录、令牌过期或无效 |
| 403 | `FORBIDDEN` | 角色不足（如非 ADMIN 查用户列表） |
| 404 | `NOT_FOUND` | 资源不存在或不属于当前用户 |
| 409 | `CONFLICT` | 邮箱已注册 |
| 422 | `UNPROCESSABLE_ENTITY` | 语义无法处理 |
| 429 | `RATE_LIMITED` | 登录锁定或模型供应商限流 |
| 500 | `INTERNAL_ERROR` | 未预期的服务端错误 |
| 502 | `AI_EMPTY_RESPONSE` | 模型返回空内容 |
| 502 | `AI_INVALID_OUTPUT` | 结构化输出两次都未通过 Zod |
| 502 | `AI_PROVIDER_AUTH` | 模型供应商鉴权失败 |
| 502 | `AI_PROVIDER_ERROR` | 其它供应商错误 |
| 503 | `AI_CONFIG_ERROR` | 服务端模型配置缺失 |
| 503 | `AI_UNAVAILABLE` | 无法连接模型服务 |
| 503 | `AI_CONCURRENCY_LIMIT` | 并发已满且排队超时 |
| 503 | `AI_CIRCUIT_OPEN` | 熔断打开，快速失败 |
| 504 | `AI_TIMEOUT` | 单次尝试超过时间预算 |

## 八、限制与约定

| 项目 | 限制 |
| --- | --- |
| 消息长度 | 1–8000 字符 |
| 会话标题 | 1–80 字符 |
| 消息分页 | `pageSize` ≤ 100 |
| 文件大小 | ≤ 5MB |
| 工具轮次 | ≤ 4 轮 |
| 结构化重试 | 首次 + 1 次修复 |
| 模型重试 | 最多 3 次尝试（仅超时 / 网络 / 429 / 5xx / 空回复） |
| 流式错误 | HTTP 200 后只能通过 `event: error` 表达 |

## 九、调用示例

```bash
# 1. 登录并提取 access token（需要 jq）
TOKEN=$(curl -s -X POST http://localhost:9527/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"P@ssw0rd123"}' \
  | jq -r '.data.tokens.accessToken')

# 2. 非流式对话
curl -s -X POST http://localhost:9527/api/ai/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"解释一下什么是 SSE","template":"assistant"}' | jq

# 3. 流式对话
curl -N -X POST http://localhost:9527/api/ai/chat/stream \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"写一句项目复盘","template":"summary"}'

# 4. 工具调用
curl -s -X POST http://localhost:9527/api/ai/tools/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"现在几点？再算 128 乘 37"}' | jq

# 5. 结构化分类
curl -s -X POST http://localhost:9527/api/ai/classify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"快递显示签收但我没收到"}' | jq
```

## 十、兼容性说明

- v1.0 起，`template`、`model` 与 SSE 事件字段视为稳定契约；新增字段不视为破坏性变更。
- `message` 的 `role` 永远由服务端决定，客户端提交的 `role` 会被 DTO 白名单剥离。
- 错误码只增不改；若某错误码语义变化，会在下个主版本说明。
