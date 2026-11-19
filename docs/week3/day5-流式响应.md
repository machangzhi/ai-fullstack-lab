# Week 3 Day 5：流式响应

> 目标：让回复边生成边显示，并能在用户停止时真正取消上游请求。

## 一、今天要解决的问题

非流式接口要等模型生成完整段落后才返回。实测一次 84 个 Token 的回复总耗时约 1 秒，但长回答会到十几秒，用户全程只能看「等待中」。

流式响应把「一次大等待」拆成「许多次小到达」：

- 首个 Token 约 388ms 就能出现，感知延迟大幅下降。
- 用户可以在不满意时立即停止，而不是等完整回复。
- 服务端在客户端断开后取消模型请求，避免继续计费。

## 二、SSE 是什么

SSE（Server-Sent Events）是基于 HTTP 的单向推送：

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: delta
data: {"type":"delta","content":"SSE"}

event: delta
data: {"type":"delta","content":" 适合"}

event: meta
data: {"type":"meta","model":"deepseek-flash","template":"assistant","usage":{...}}
```

规则：

- 一条事件以空行结束，字段用 `event:` 和 `data:` 描述。
- 连接保持打开，服务端可以持续写入。
- 相比 WebSocket，SSE 是单向的、纯 HTTP，不需要协议升级，鉴权和网关配置都更简单。

## 三、连接生命周期

```text
浏览器 POST（带 JWT）
  → Guard 校验，失败直接 401（此时还没发响应头）
  → Controller 设置 SSE 响应头并 flushHeaders
  → 循环写 delta 事件
  → 写一条 meta 事件（模型名、模板、用量）
  → res.end()
```

异常路径：

- 模型报错发生在响应头之后，HTTP 状态码已经固定为 200，**不能再改 4xx/5xx**。
- 因此错误改为 `event: error` 下发，前端解析后按业务错误处理。

这是流式接口最重要的约束：**状态码只在开头有效，之后只能靠事件表达结果。**

## 四、断连处理

客户端关闭连接时，Express 的 `req` 触发 `close`。服务端用 `AbortController` 把信号传给 OpenAI SDK：

```ts
const abortController = new AbortController();
req.on('close', () => abortController.abort());
```

调用链：

```text
req close
  → abortController.abort()
  → transport.stream(..., { signal })
  → SDK 中断 HTTP 请求
  → AiService 捕获中断，识别为主动断开，不抛错
```

如果不做这一步，用户点了「停止生成」，服务端仍会继续把整段回复生成完——费用照付，只是没人接收。

## 五、前端实现

文件：[chat-stream.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/web/src/api/chat-stream.ts)

### 5.1 为什么不用 axios

axios 在浏览器中通常等响应体接收完才 resolve，拿不到逐块数据。这里用 `fetch` + `response.body.getReader()`。

### 5.2 三个容易踩的坑

1. **分块不等于事件**：网络可能把一条事件切成两半，必须维护 buffer，按 `\n\n` 切分。
2. **中文可能被切断**：`TextDecoder.decode(value, { stream: true })` 会保留不完整的多字节字符，避免乱码。
3. **停止不是报错**：`abort()` 会让 fetch 抛 `AbortError`，前端应保留已生成内容并静默结束，而不是弹错误。

### 5.3 交互

- 生成中显示「停止生成」和光标动画。
- 停止后保留已生成内容，可直接「重新生成」。
- 收到 meta 后展示模型名和 Token 用量。
- 401 时用 refresh token 换新令牌并重试一次；仍失败才提示重新登录。

## 六、真实调用结果

本地服务层直连 DeepSeek：

**流式生成**

```json
{
  "deltas": 84,
  "firstDeltaMs": 388,
  "totalMs": 1050,
  "model": "deepseek-flash",
  "template": "assistant",
  "usage": { "promptTokens": 152, "completionTokens": 84, "totalTokens": 236 }
}
```

**主动中断**（收到第 3 个 delta 时 abort）

```json
{ "deltas": 4, "abortedAtMs": 544, "threw": false }
```

中断后生成器正常结束，没有抛错，也没有再发送 meta。

## 七、验收记录

- `@ai-lab/api` 测试 **27/27 通过**（新增 5 项：SSE 解析、服务层事件顺序、空响应、客户端中断、流式超时映射）。
- `@ai-lab/ai-core` 测试 **32/32 通过**。
- 前端 `typecheck` 与生产构建通过；全仓 lint **0 errors**，33 个 warnings 仍为此前的 Vue 格式告警。
- 真实 DeepSeek 流式与中断均已验证。

## 八、自测题

1. 为什么流式接口的模型错误不能返回 500，而要发 error 事件？
2. 客户端断开后，服务端为什么还必须主动取消模型请求？
3. `TextDecoder` 为什么需要 `stream: true`？

### 参考答案

1. SSE 是「先发响应头、再持续写内容」的模式。响应头一旦发出，HTTP 状态码就已经确定为 200，之后无法再修改；此时抛异常让框架返回 500 也不会生效，甚至可能报「headers already sent」。所以协议内约定用 `event: error` 携带业务错误码，前端据此展示并结束。
2. 断开的只是浏览器连接，模型请求仍独立进行。如果不取消，服务端会继续生成、继续计费，占用并发额度，而结果没有任何接收方。用 `AbortController` 把客户端生命周期传递到 SDK，才能做到「停止即停止」。
3. 一个 UTF-8 中文字符占 3 个字节，网络分块可能在字符中间切断。`stream: true` 会让解码器保留不完整字节，等下一块到达后再组合解码；否则会出现乱码或替换字符。

## 九、今日三行

- 今天解决了什么问题：新增 SSE 接口和前端逐 Token 渲染，支持停止生成、重新生成和错误事件。
- 为什么这样设计：用 AbortController 贯穿客户端与服务端；流式接口用事件而非状态码表达结果。
- 还有什么不确定：Nginx 缓冲、代理超时和移动网络下的断线重连仍需在真实网关环境验证；下一周会进入更完整的会话能力。

## 十、生产部署与线上验收（2026-11-19）

- 页面：`http://118.89.166.194/lab/`；流式接口：`POST /lab/api/ai/chat/stream`。
- Nginx 关键改动：在 `/lab/api/` 增加 `proxy_buffering off;`。不加这一行，Nginx 会先攒满缓冲再转发，前端看到的仍是「一次性出现」，流式等于失效。
- 发布前备份：`/var/backups/ai-fullstack-lab/20261119-222803`（含站点文件、API dist 与 Nginx 配置）。
- 经 Nginx 的真实链路验收：

| 场景                 | 结果                                           |
| -------------------- | ---------------------------------------------- |
| 无 JWT               | 401（响应头发出前就被 Guard 拦截）             |
| 流式回复             | 200，`text/event-stream; charset=utf-8`        |
| 响应头到达           | 14ms                                           |
| 首个 delta           | 520ms                                          |
| 完整生成             | 102 个 delta，总耗时 1276ms                    |
| 用量                 | 149 / 102 / 251，模型 `deepseek-flash`         |
| 第 3 个 delta 后中断 | 客户端收到 4 个 delta 后结束，服务端日志无异常 |

- 浏览器验收：卡片标题「DeepSeek 流式对话」、标签「单轮 · SSE 流式」、未登录提示与禁用态均正常，控制台无 error。
- 验收时发现首页 HTML 被浏览器缓存，直接访问 `/lab/` 会看到旧版本；本次用带版本参数的地址强制刷新。后续应给 `index.html` 配置 `Cache-Control: no-cache`，而对带哈希的静态资源设置长期缓存。
