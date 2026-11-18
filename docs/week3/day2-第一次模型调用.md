# 第 3 周 Day 2 笔记：第一次 DeepSeek 模型调用

> 本日目标：理解 Chat Completions 的 system/user/assistant 消息，完成 `POST /api/ai/chat` 和首页问答；通过 DeepSeek 官方 OpenAI 兼容端点调用 `deepseek-chat`，处理超时与错误码，确保密钥只放服务端。

---

## 一、Chat Completions 的三种消息角色

| 角色        | 由谁提供      | 本次用途                             |
| ----------- | ------------- | ------------------------------------ |
| `system`    | 服务端固定    | 规定助手身份、回答语言和不确定性表达 |
| `user`      | 当前登录用户  | 携带本次问题，去除首尾空白后发送     |
| `assistant` | DeepSeek 返回 | 作为回复展示，不由客户端伪造         |

本次请求是单轮、非流式调用，只包含一条 system 和一条 user 消息，不携带历史消息，也不写入数据库。后续多轮对话才把历史消息按顺序加入请求。

## 二、为什么是 OpenAI SDK，但调用的是 DeepSeek

DeepSeek 提供 OpenAI 兼容的 Chat Completions 接口。SDK 只是协议客户端，真正请求地址由 `baseURL` 决定：

```text
POST https://api.deepseek.com/v1/chat/completions
Authorization: Bearer <服务端 MODEL_API_KEY>
```

本次服务端配置为：

```dotenv
MODEL_PROVIDER=deepseek
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_NAME=deepseek-chat
MODEL_API_KEY=<只填写在本地服务端 .env，不提交>
```

密钥已写入本地 `apps/api/.env`，该文件已被 `.gitignore` 忽略；笔记不记录密钥内容。自动化测试仍使用假密钥和模拟响应，真实冒烟结果见第九节，不能把模拟结果当成真实模型结果。

## 三、请求数据流

```text
首页 AiChatPanel
  → POST /api/ai/chat（携带用户 JWT，而非模型密钥）
  → ChatRequestDto 校验
  → JwtAuthGuard 验证登录
  → AiService 组装 system/user
  → OpenAiChatTransport 读取 Day 1 配置
  → DeepSeek /chat/completions
  → 提取 assistant 文本、模型名和 usage
  → 统一成功响应
  → 首页展示回复和 Token 用量
```

模型密钥只出现在服务端环境变量和发往 DeepSeek 的 `Authorization` 请求头中。浏览器持有的是应用自己的用户 JWT，两者用途不同，不能混用。

## 四、接口契约

请求：

```http
POST /api/ai/chat
Authorization: Bearer <用户 access token>
Content-Type: application/json
```

```json
{
  "message": "什么是上下文窗口？"
}
```

`message` 必须是 1～8000 个字符的字符串，不能只包含空白。接口要求登录，避免匿名请求消耗模型额度。

成功时 HTTP 200，`data` 结构为：

```json
{
  "reply": "上下文窗口是……",
  "model": "deepseek-chat",
  "usage": {
    "promptTokens": 20,
    "completionTokens": 12,
    "totalTokens": 32
  }
}
```

外层仍包含项目统一的 `success`、`requestId` 和 `timestamp`。部分兼容服务可能不返回 `usage`，此时接口返回 `usage: null`，前端不显示 Token 统计。

## 五、模型参数与超时

| Day 1 配置    | Chat Completions 参数 | 作用                    |
| ------------- | --------------------- | ----------------------- |
| `model`       | `model`               | 指定 `deepseek-chat`    |
| `temperature` | `temperature`         | 控制采样随机性          |
| `maxTokens`   | `max_tokens`          | 限制本次输出 Token 预算 |
| `timeoutMs`   | SDK `timeout`         | 限制等待模型响应的时间  |

SDK 的 `maxRetries` 设置为 `0`。第一次模型调用先明确观察错误，不在未控制次数和费用时自动重试。浏览器该请求超时为 40 秒，略高于服务端默认 30 秒；其他前端请求仍保持原来的 20 秒默认值。

## 六、错误码与安全映射

| 场景                     | HTTP | 稳定错误码          | 处理原因                              |
| ------------------------ | ---- | ------------------- | ------------------------------------- |
| 服务端模型配置缺失或非法 | 503  | `AI_CONFIG_ERROR`   | 检查本地环境变量，不泄露具体值        |
| 模型调用超时             | 504  | `AI_TIMEOUT`        | 提示稍后重试                          |
| 无法连接模型服务         | 503  | `AI_UNAVAILABLE`    | 与业务接口故障区分                    |
| DeepSeek 返回 401/403    | 502  | `AI_PROVIDER_AUTH`  | 检查模型密钥；不触发前端用户 JWT 刷新 |
| DeepSeek 返回 429        | 429  | `RATE_LIMITED`      | 遵循现有限流错误约定                  |
| 模型返回空内容           | 502  | `AI_EMPTY_RESPONSE` | 不展示空白成功结果                    |
| 其他供应商异常           | 502  | `AI_PROVIDER_ERROR` | 不透传原始供应商响应                  |

供应商 401 表示“应用到模型服务”的认证失败；应用接口的 401 表示“浏览器到应用”的用户认证失败。若把前者原样返回，Axios 拦截器会错误地刷新用户 Token，因此映射为 502。

## 七、Token 用量与费用观察

响应中的 `usage` 是本次真实计费观察的重要依据：

- `promptTokens`：system、user 等输入消耗的 Token。
- `completionTokens`：assistant 输出消耗的 Token。
- `totalTokens`：本次总用量。
- 费用仍需按 DeepSeek 当前计费规则分别计算，不能只用总 Token 乘一个猜测单价。

Day 1 的费用估算在这里变成了可观察数据。后续用量日志应保存请求 ID、模型、Token 和耗时，但仍不能记录密钥。

## 八、今日实操文件

- [DeepSeek/OpenAI 兼容传输层](../../apps/api/src/modules/ai/openai-chat.transport.ts)
- [问答 Service](../../apps/api/src/modules/ai/ai.service.ts)
- [POST /ai/chat Controller](../../apps/api/src/modules/ai/ai.controller.ts)
- [请求 DTO](../../apps/api/src/modules/ai/dto/chat.dto.ts)
- [前端问答卡片](../../apps/web/src/components/AiChatPanel.vue)
- [DeepSeek 环境变量示例](../../apps/api/.env.example)
- [自动化测试](../../apps/api/tests/ai-chat.test.cjs)

## 九、验收记录

- 根目录构建、类型检查通过；ESLint 为 **0 errors**。剩余 33 个 warnings 均位于本次未修改的 `App.vue`、`LoginView.vue` 和 `UsersView.vue`，Day 2 新增文件无 lint 警告。
- Day 2 新增文件、后端改动和本笔记通过 Prettier 检查。`client.ts` 与 `HomeView.vue` 在 Day 2 前就存在全文件 Prettier 格式差异，本次仅保留必要改动，不做无关重排。
- `ai-core` 自动化测试 **13/13 通过**；API Day 2 自动化测试 **14/14 通过**，全程使用假密钥和模拟响应，不访问真实模型。
- 已验证 DeepSeek 官方请求地址、Bearer 认证头、`deepseek-chat`、采样参数、消息角色、usage 映射和空回复处理。
- 已验证配置缺失、超时、断网、供应商认证、限流和未知异常的安全错误映射。
- 本地隔离 HTTP 验收复用实际编译后的 Controller、Service、Transport、JWT Guard、校验管道和统一响应/异常处理，仅将登录与模型服务替换为本地 mock：无 Token 返回 401；普通问答返回 200、`deepseek-chat` 和 Token 21/9/30；限流返回 429 `RATE_LIMITED`；超时返回 504 `AI_TIMEOUT`；错误响应不包含模拟密钥。
- 真实浏览器验收通过：登录后能看到“DeepSeek 第一次对话”，普通问题展示固定 mock 回复与 Token 21/9/30；限流和超时分别展示安全错误文案；`POST /api/ai/chat` 状态分别为 200、429、504，控制台无 error。
- 前端生产构建产物中未检出 `MODEL_API_KEY`、测试密钥或本地 mock 密钥。
- 完整应用启动仍依赖现有 PostgreSQL `127.0.0.1:55432`；本次环境未连接该数据库（Prisma `P1001`），因此 HTTP 与浏览器验收使用隔离服务，不修改数据库配置。
- 本地真实 DeepSeek 冒烟：**已通过**。使用实际 `AiService` 与 `OpenAiChatTransport`，请求配置模型为 `deepseek-chat`，输出上限临时设为 32 Token；模型回复“DeepSeek 连接成功”，usage 为输入 39、输出 6、总计 45。供应商响应中的 `model` 字段实际为 `deepseek-flash`，与请求配置名不同，按真实响应记录，后续再核对模型别名规则。此前 HTTP 与浏览器验收中的模型内容来自本地 mock，不与本次真实结果混淆。

---

## 十、自测题与参考答案

### 1. 为什么客户端只能提交 user 文本，不能直接指定 system 或 assistant？

system 是应用给模型设定的行为边界，应由服务端统一管理。允许客户端任意覆盖，会绕过应用约束。assistant 应代表模型历史输出，允许客户端伪造会污染上下文，影响后续回答和提示词注入防护。因此 Day 2 的 DTO 只开放 `message`，由 Service 固定组装角色。

### 2. 为什么 DeepSeek 的 401 不能原样返回给浏览器？

应用前端的 401 已约定为“用户 JWT 失效”，Axios 会尝试刷新用户 Token。DeepSeek 的 401 则表示模型 API Key 无效，刷新用户 Token 无法解决。将其映射为 502 `AI_PROVIDER_AUTH`，既能保留稳定的错误语义，也能避免错误的认证联动。

### 3. 为什么本次关闭 SDK 自动重试？

超时或 5xx 后自动重试可能再次产生模型调用和费用，也会让排队中的请求等待更久。Day 2 的目标是先看清超时、限流和供应商错误，建立可观测、安全的错误边界。后续实现可靠性策略时，再根据错误类型、幂等性、退避和费用预算决定有限重试。

---

## 十一、今日三行

- 今天解决了什么问题：打通了登录用户提问、服务端组装消息、DeepSeek 兼容调用和前端回复/用量展示的完整链路。
- 为什么这样设计：配置与网络传输分离，传输层可替换测试；用户 JWT 与模型密钥隔离；供应商错误转成安全、稳定的应用错误。
- 还有什么不确定：本次真实请求配置为 `deepseek-chat`，供应商响应标识为 `deepseek-flash`；后续需核对 DeepSeek 的模型别名与返回字段规则。

## 十二、生产部署（2026-11-18）

- 页面：`http://118.89.166.194/lab/`；健康接口：`http://118.89.166.194/lab/api/health`。
- 沿用现有 Nginx `/lab/` 路由和 `lab-api.service`，保留 PostgreSQL、JWT 配置、上传目录与其他站点；DeepSeek Key 仅写入服务器 `/var/www/lab-api/.env`，权限已收紧为 `600`。
- 发布前备份：`/var/backups/ai-fullstack-lab/20261118-231928`。
- 验收结果：公网页面 200、健康接口 200、无 JWT 的聊天请求 401；服务器真实 DeepSeek 调用回复“DeepSeek 连接成功”，usage 为输入 39、输出 6、总计 45，响应模型字段仍为 `deepseek-flash`。
- 当前入口使用 HTTP。若用于真实账号或非测试数据，还应配置域名与 HTTPS，避免凭证和 Token 在明文连接中传输。
