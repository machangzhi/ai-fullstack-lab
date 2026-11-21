# Week 4 Day 3：工具调用入门

> 目标：让模型从「只会生成文本」变成「可以请求服务端执行工具，再根据真实结果回答」：模型负责选择工具与参数，服务端负责校验、执行和回填。

## 一、为什么需要工具调用

有两类问题模型本身不可靠：

1. **实时信息**：模型不知道「现在几点」。训练数据有时间边界，让它猜时间只会得到看似合理的错误答案。
2. **精确计算**：大模型做算术是「生成」而不是「计算」，多位小数、乘除和边界值很容易出错。

工具调用的分工是：

```text
模型：判断要不要用工具、用哪个、参数是什么
服务端：校验参数、执行真实代码、把结果作为 tool 消息回填
模型：基于工具结果组织最终回答
```

模型始终拿不到数据库连接、文件系统或任意命令执行能力，只能从白名单工具中选择。

## 二、工具契约：JSON Schema 与 Zod 同源

实现：[tool-registry.service.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/ai/tools/tool-registry.service.ts)

今天定义两个工具：

| 工具               | 用途                 | 参数                                               |
| ------------------ | -------------------- | -------------------------------------------------- |
| `get_current_time` | 获取指定时区当前时间 | `timezone?`（IANA 时区，默认 `Asia/Shanghai`）     |
| `calculator`       | 两个数字的四则运算   | `operation`、`left`、`right`（必填，禁止额外字段） |

每个工具同时有两份描述：

- **JSON Schema**：发给模型，告诉它参数结构与约束；
- **Zod schema**：执行前校验模型真正传回来的参数。

两份描述必须一致。只写 JSON Schema 而不校验，等于相信模型永远不会传错；只写 Zod 而不告诉模型，模型只能猜参数格式。

`additionalProperties: false` + `.strict()` 是刻意设计：模型多传一个 `secret` 字段也应被拒绝，避免参数被悄悄带进执行层。

## 三、工具调用循环

实现：[tool-chat.service.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/ai/tools/tool-chat.service.ts)

```text
system：工具规则 + 注入防护
user：本次问题
  ↓
模型返回 tool_calls？
  ├─ 否 → 直接返回最终文本
  └─ 是 → 逐条校验并执行
        → 回填 assistant(tool_calls) + tool(tool_call_id, result)
        → 再次请求模型（最多 4 轮）
```

几个容易踩坑的点：

1. **assistant 消息必须带原样的 `tool_calls`**。只回填 tool 结果而不回填请求，模型找不到 `tool_call_id`，多数供应商会直接报错。
2. **tool 消息必须带 `tool_call_id`**。一次可能并行请求多个工具，ID 是唯一对应关系。
3. **循环必须有硬上限**。模型可能反复调用同一个工具；没有上限时请求永远不结束。这里最多 4 轮，超过返回 `AI_TOOL_LOOP_LIMIT`。
4. **中间轮次的 Token 也要计费**。`usage` 按轮累加，最终写入 `usage_logs`，`template=tool-chat`。

## 四、参数不合法怎么办

工具参数是模型生成的，不是可信输入。执行边界分五层：

| 边界         | 行为                                               |
| ------------ | -------------------------------------------------- |
| 工具白名单   | 未登记的工具直接返回「未知工具」，不尝试动态加载   |
| 参数长度     | 超过 4000 字符直接拒绝，防止异常大的 JSON 进入解析 |
| JSON 解析    | 解析失败返回「不是合法 JSON」                      |
| Zod 严格校验 | 类型、枚举、必填、额外字段全部检查                 |
| 执行超时     | 单次工具 2 秒超时，避免慢工具拖住整个请求          |

校验失败不会抛给客户端，而是作为一条 `tool` 错误消息回填给模型：

```json
{ "ok": false, "error": "除数不能为 0。" }
```

模型看到错误后可以修正参数重试一次；仍然失败就应如实告诉用户。**错误隔离的意思是：一个工具失败，不应该让整个对话直接 500。**

## 五、协议适配

实现：[openai-chat.transport.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/ai/openai-chat.transport.ts)

内部消息类型只有三种：

```ts
type ToolChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; content: string };
```

到 OpenAI 兼容协议时才映射为：

- `assistant.tool_calls: [{ id, type: 'function', function: { name, arguments } }]`
- `tool: { role: 'tool', tool_call_id, content }`
- 请求参数增加 `tools` 与 `tool_choice: 'auto'`

业务层（`ToolChatService`）不需要知道 OpenAI SDK 的存在；`LlmService` 仍然负责按模型档案路由。

## 六、接口

```text
POST /api/ai/tools/chat
Authorization: Bearer <token>

{ "message": "现在上海几点？再帮我算 23 × 47", "model": "deepseek-chat" }
```

响应：

```json
{
  "reply": "现在是……；23 × 47 = 1081。",
  "modelId": "deepseek-chat",
  "model": "deepseek-chat",
  "rounds": 2,
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "toolRuns": [
    {
      "round": 1,
      "id": "call_xxx",
      "name": "get_current_time",
      "arguments": "{\"timezone\":\"Asia/Shanghai\"}",
      "ok": true,
      "output": { "timezone": "Asia/Shanghai", "iso": "...", "local": "..." },
      "durationMs": 1
    }
  ]
}
```

`toolRuns` 是执行轨迹，用于调试与后续审计；它只包含工具名、参数和结果，不包含系统提示词或密钥。

## 七、测试与验收

新增测试：[tools.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/tools.test.cjs)

覆盖：

- 工具目录与两个工具的正常执行；
- 非法 JSON、缺失字段、额外字段、除零、未知工具、非法时区；
- 完整工具循环：请求 → 执行 → tool 回填 → 最终回答；
- 错误回填后模型仍能结束对话；
- 轮次上限；
- 无需工具时直接回答；
- 传输层把工具 Schema 原样发出并解析 `tool_calls`。

结果：

| 包                | 结果       | 说明                  |
| ----------------- | ---------- | --------------------- |
| `@ai-lab/ai-core` | 55/55 通过 | 本日未改核心包        |
| `@ai-lab/api`     | 50/50 通过 | 新增 8 项工具调用测试 |
| `@ai-lab/web`     | 构建通过   | 本日未接前端入口      |
| API lint          | 0 errors   | 新增文件通过 ESLint   |

全部测试使用假模型与假 Prisma，不访问网络、不写数据库。

真实联调示例：

```bash
curl -X POST http://localhost:3000/api/ai/tools/chat \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message":"现在上海几点？"}'
```

预期模型先返回 `get_current_time` 的工具调用，服务端执行后回填，第二轮产生最终回答。

## 八、已知限制

- 只有非流式接口；工具中间轮次不适合直接拼接 SSE 文本。
- 多个工具调用按顺序执行，尚未并行化。
- 没有人工确认机制；当前两个工具都无副作用，涉及退款、删除等操作时必须等 Week 8 的确认与审计能力。
- 工具执行轨迹只返回给本次请求，没有落库；服务重启后无法回放。
- 没有前端工具调用可视化入口，验证依赖 Swagger / curl。
- 新增了 `zod` 直接依赖；API 包需要在干净环境下重新 `pnpm install`。
- 「模型是否该调用工具」仍由模型判断，可能出现多调用或漏调用，需要 Week 4 Day 5 的评测集量化。

## 九、自测题

1. 既然 JSON Schema 已经描述了参数，为什么执行前还要用 Zod 校验？
2. 为什么工具错误要作为 `tool` 消息回填，而不是直接返回 500？
3. 为什么工具循环必须有轮次上限？
4. 一次返回多个 `tool_calls` 时，服务端回填最容易漏掉什么？

### 参考答案

1. JSON Schema 是给模型的「说明书」，不是执行前的强制检查。模型可能不遵守 schema，甚至被注入后构造额外字段。服务端必须在真正执行前独立校验，且校验规则应比给模型的描述更严格。
2. tool 消息是对话协议的一部分，模型可以读取错误并修正参数或换一种方式回答。直接 500 会让用户丢失本轮对话，也无法区分「模型选错工具」和「服务不可用」。
3. 模型可能陷入「调用 → 失败 → 再调用」的循环，或者不断请求同一个工具。上限保证请求一定会结束，并给出可识别的 `AI_TOOL_LOOP_LIMIT`，避免无限消耗 Token。
4. 对应的 `tool_call_id`。一次多个调用时，每个 tool 结果必须回填到自己的 ID；漏掉或错配会让模型无法把结果和请求对应起来，部分供应商会直接拒绝请求。

## 十、今日三行

- 今天解决了什么问题：实现白名单工具注册、Zod 参数校验、OpenAI 工具协议映射和最多四轮的工具调用循环。
- 为什么这样设计：模型只负责选择，服务端负责执行边界；错误回填而不是抛错；循环有上限、用量按轮累计。
- 还有什么不确定：模型选择工具的准确率、多个工具的并行执行、需要人工确认的危险操作，留到后续评测与 Week 8 处理。
