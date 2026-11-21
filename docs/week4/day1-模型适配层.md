# Week 4 Day 1：模型适配层

> 目标：把 Week 3「一个进程只能连一个模型」的实现升级为统一 LLMService：同一套业务代码可以在多个 OpenAI 兼容模型之间切换，配置、错误和公开信息都有明确边界。

## 一、Week 3 留下的问题

Day 2 的 `OpenAiChatTransport` 直接读取 `process.env`，一个进程只能创建一个模型配置：

1. 想对比 `deepseek-chat` 和 `deepseek-reasoner`，只能改环境变量再重启。
2. 业务层虽然只依赖 `ChatTransport`，但「选择哪个模型」没有协议字段。
3. 模型名、地址、超时全混在一份配置里，前端无法知道有哪些模型可选。
4. 所有配置错误都被压成同一个 503，客户端传错模型也无法区分。

今天不新增业务功能，只解决「可维护地接入多个模型」。

## 二、模型档案：公开别名 + 继承式覆盖

核心实现：[ai-core/src/index.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/src/index.ts)

新增 `resolveModelProfiles(env)`，把配置拆成两层：

```text
基础配置（MODEL_PROVIDER / BASE_URL / API_KEY / 采样参数）
  └─ 档案 deepseek-chat   → 覆盖 MODEL、LABEL、CONTEXT_WINDOW
  └─ 档案 deepseek-reasoner → 覆盖 MODEL、TEMPERATURE、API_KEY_ENV
```

| 配置                                | 作用                                     |
| ----------------------------------- | ---------------------------------------- |
| `MODEL_PROFILES`                    | 逗号分隔的公开别名，客户端只能用它切换   |
| `MODEL_DEFAULT_PROFILE`             | 默认档案，不传 `model` 时使用            |
| `MODEL_PROFILE_<ID>_LABEL`          | 展示名，仅用于前端                       |
| `MODEL_PROFILE_<ID>_MODEL`          | 真实模型名，可以换成供应商的任意模型别名 |
| `MODEL_PROFILE_<ID>_API_KEY_ENV`    | 只写环境变量名，密钥本身仍在环境变量里   |
| `MODEL_PROFILE_<ID>_TEMPERATURE` 等 | 覆盖采样与超时参数                       |
| `MODEL_PROFILE_<ID>_CONTEXT_WINDOW` | 上下文窗口，供 Day 2 做 Token 预算       |
| `MODEL_PROFILE_<ID>_STREAMING`      | 是否支持流式，为后续降级保留能力位       |

未配置 `MODEL_PROFILES` 时，自动生成一个 `id=default` 的档案，Week 3 的行为完全不变；这是兼容旧环境的默认路径。

几条刻意的约束：

- **别名必须可控**：只允许 1～32 位小写字母、数字和连字符，避免把任意字符串带进日志和前端。
- **换供应商必须换地址**：`PROVIDER` 改变却没写 `BASE_URL` 时直接报错，防止把密钥发到错误服务。
- **档案数量上限 8**：多模型是能力，不是让环境变量无限膨胀。
- **错误信息不含值**：只报变量名与允许值，避免密钥进入异常日志。

公开信息用白名单 [toPublicModelProfile](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/src/index.ts)：只返回 `id / label / provider / model / temperature / maxTokens / capabilities`，`apiKey`、`baseUrl`、`timeoutMs` 一律不出服务端。

## 三、统一 LLMService

新文件：[llm.service.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/ai/llm.service.ts)

```text
AiController
  → AiService（Prompt 组装 + 错误映射）
    → LlmService（档案目录 + 客户端缓存 + 路由）
      → OpenAiChatTransport（单个档案的 OpenAI 兼容协议）
```

`OpenAiChatTransport` 从一个「读环境变量的全局客户端」改成「一个档案一个适配器」：

- 构造函数接收已经解析好的 `ModelProfileConfig`，因此一次进程可以同时持有多个模型客户端。
- 返回值增加 `profileId`，SSE `meta` 也携带它，前端能知道这条回答来自哪个档案。
- OpenAI SDK 仍只停留在这一层，`AiService` 及以上完全看不到 SDK。

`LlmService` 的三个关键取舍：

1. **惰性解析**：和 Week 3 一样，密钥缺失不会让应用启动失败；只有真正调用模型或查询目录时才报 `AI_CONFIG_ERROR`。
2. **客户端缓存**：同一档案只创建一次客户端，避免每次请求都新建 HTTP 连接池。
3. **错误分层**：配置缺失 → `ChatConfigurationError`（503）；客户端传了不存在的别名 → `UnknownModelProfileError`（400）。未知模型是请求问题，不该被当成服务故障重试。

## 四、切换链路

| 层       | 变化                                                               |
| -------- | ------------------------------------------------------------------ |
| DTO      | `ChatRequestDto` 新增可选 `model`，只校验格式，不校验是否存在      |
| 单轮接口 | `POST /api/ai/chat`、`POST /api/ai/chat/stream` 接受 `model`       |
| 多轮接口 | `POST /api/conversations/:id/messages/stream` 透传 `model`         |
| 服务端   | `AiService` 把档案 ID 交给 `LlmService`，`LlmService` 决定真实模型 |
| 前端     | `GET /api/ai/models` 拉取目录，聊天页出现模型下拉框                |
| 用量日志 | 仍记录供应商实际返回的 `model`，便于成本核算                       |

新增接口：

```text
GET /api/ai/models
{
  "defaultId": "deepseek-chat",
  "models": [
    { "id": "deepseek-chat", "label": "DeepSeek Chat", "capabilities": { ... } },
    { "id": "deepseek-reasoner", "label": "DeepSeek Reasoner", "capabilities": { ... } }
  ]
}
```

为什么不在 DTO 里用 `@IsIn` 校验模型：档案来自运行时环境变量，DTO 是静态类，两者不可能保持同步。DTO 只挡非法格式，是否存在由服务端目录判断，并返回明确的 `AI_MODEL_UNKNOWN`。

## 五、模型能力差异

`capabilities` 目前只记录两个当前真正用得上的字段：

- `streaming`：不是所有兼容实现都支持 SSE；保留该能力位，后续可以降级为一次性返回。
- `contextWindow`：直接服务 Day 2 的上下文预算。不同模型窗口不同，不能把 `maxTokens`（输出预算）当成历史预算。

另外提醒一个真实差异：推理模型（如 `deepseek-reasoner`）对温度等采样参数的处理与普通对话模型不同，部分供应商会忽略这些参数。档案层允许分别配置，但**不要把「配置了温度」等同于「模型一定按该温度采样」**，能力差异应以供应商文档为准。

## 六、测试与验收

新增测试：

- [model-profiles.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/tests/model-profiles.test.cjs)：基础继承、档案覆盖、默认档案、公开白名单、非法 ID / 重复 ID / 数量上限、非法布尔值、密钥变量缺失、切换供应商缺地址或模型。
- [ai-models.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/ai-models.test.cjs)：默认路由、显式切换、客户端复用、未知档案 400、配置缺失 503、目录脱敏、流式 signal 透传。

结果：

| 包                | 结果       | 说明                               |
| ----------------- | ---------- | ---------------------------------- |
| `@ai-lab/ai-core` | 47/47 通过 | 新增 8 项多档案测试                |
| `@ai-lab/api`     | 38/38 通过 | 新增 6 项 LlmService 测试          |
| `@ai-lab/web`     | 构建通过   | `vue-tsc` + Vite 生产构建          |
| 全仓 lint         | 0 errors   | 33 个 warnings 为既有 Vue 格式告警 |

测试全部使用假 env 与假客户端，不读取真实密钥、不访问网络。

**没有做真实模型调用验收**：模型切换的成本与实际行为依赖本机 `.env` 是否配置了两个档案。要实测时，把 `.env.example` 中的 `MODEL_PROFILES` 与 `MODEL_PROFILE_*` 复制到 `apps/api/.env`，启动后：

```text
GET  /api/ai/models
POST /api/ai/chat        { "message": "你好", "model": "deepseek-reasoner" }
POST /api/ai/chat/stream { "message": "你好", "model": "deepseek-chat" }
```

预期：两个请求的 SSE `meta.modelId` 不同，`model` 为供应商实际返回名，`/api/ai/usage` 中按实际模型分别累计。

## 七、已知限制

- 基础 `MODEL_API_KEY` 仍是必填；即使每个档案都通过 `API_KEY_ENV` 提供了自己的密钥，也还需要一个基础密钥作为默认值。多密钥完全独立要等后续配置重构。
- 档案不落库，也不支持运行时热更新；改配置需要重启进程。
- 用量日志只记录供应商模型名，没有记录公开档案 ID，跨档案但同模型时无法区分。
- `capabilities.streaming=false` 目前只是声明，尚未实现「自动降级为非流式」。
- 前端只在模型数量大于 1 时显示下拉框，没有展示上下文窗口等能力信息。

## 八、自测题

1. 为什么客户端只能提交档案 ID，不能提交真实模型名？
2. 未知档案为什么返回 400，而配置缺失返回 503？
3. 为什么 `LlmService` 要缓存客户端，而不是每次请求新建？
4. 未配置 `MODEL_PROFILES` 时为什么必须保持可用？

### 参考答案

1. 真实模型名和供应商地址属于服务端配置。如果允许客户端提交模型名，等于把「能调用哪些模型、发往哪个地址」交给不可信输入，轻则越权调用高价模型，重则配合自定义地址泄露密钥。公开别名把选择范围限制在服务端白名单内。
2. 400 表示请求本身有问题：别名不在目录里，重试也不会成功；503 表示服务端配置或上游不可用，属于运维问题。把两者混在一个错误码里，会让前端无法判断该提示用户刷新，还是提示稍后重试。
3. OpenAI 客户端内部持有连接池和超时配置，复用可以减少握手与内存开销；同时档案与客户端一一对应，缓存键就是档案 ID，逻辑简单且不会串模型。
4. Week 3 的单模型环境变量是既有部署方式，升级不能要求所有环境立刻重写配置。默认生成 `default` 档案，让旧 `.env` 零改动继续工作，这是兼容性边界，不是功能冗余。

## 九、今日三行

- 今天解决了什么问题：把单模型全局客户端升级为支持多档案切换的统一 LLMService，并补上前端模型选择与公开模型目录。
- 为什么这样设计：档案继承基础配置、公开别名隔离真实模型、错误按「请求错误 / 配置故障」分层、客户端按档案缓存。
- 还有什么不确定：基础密钥必填限制了完全独立的双密钥；能力位尚未驱动实际降级；真实多模型切换的延迟与费用还需要在配置齐全后实测。
