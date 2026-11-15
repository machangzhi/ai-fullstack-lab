# Day 5 笔记：接口规范与调试

> 日期：2026-11-15
> 对应计划：第 1 周 · Day 5 —— 设计 REST 接口、统一响应、错误码、日志、调试、Swagger
> 编码练习：/health、/users、/config 三组接口 + 统一响应 + 错误码

## 0. 一句话总结

**接口是给两类"客户端"看的：人（队友、未来的你）和程序（前端、下游服务）。** 规范的作用是让程序能稳定判断、让人能快速排查。

---

## 1. REST 设计：资源 + 方法 + 状态码

### 1.1 路径用名词，动作用方法

| 设计 | 评价 |
| --- | --- |
| `GET /api/users` | ✅ 列表 |
| `GET /api/users/:id` | ✅ 详情 |
| `POST /api/users` | ✅ 创建 |
| `GET /api/getUsers` | ❌ 动词进路径 |
| `POST /api/users/delete?id=1` | ❌ 用 POST 做删除 |

四条铁律：**复数名词、层级表达归属、动作用 HTTP 方法、过滤用 query**。

```bash
GET /api/users?page=1&pageSize=10&keyword=ali&role=admin
```

### 1.2 状态码要"说真话"

| 码 | 含义 | 本项目场景 |
| --- | --- | --- |
| 200 | 成功 | 查询、更新成功 |
| 201 | 已创建 | 创建成功（含 `Location` 头） |
| 204 | 成功无内容 | 删除成功 |
| 400 | 请求参数错 | DTO 校验失败 |
| 401 | 未认证 | 第 2 周无 token |
| 403 | 已认证但无权限 | 普通用户访问管理接口 |
| 404 | 资源不存在 | 用户 id 不存在 |
| 409 | 冲突 | 邮箱重复注册（第 2 周） |
| 422 | 语义错误 | 参数格式对但业务不合法 |
| 429 | 限流 | 第 3 周模型调用限流 |
| 500 | 服务端错误 | 未捕获异常 |

**不要所有错误都返回 200**。"HTTP 200 + body 里 code=500" 会让所有监控、网关、日志系统集体失明。

### 1.3 幂等性

| 方法 | 幂等 | 说明 |
| --- | --- | --- |
| GET | ✅ | 查询多少次都一样 |
| PUT | ✅ | 全量替换，重复执行结果相同 |
| DELETE | ✅ | 删两次，第二次 404，但状态一致 |
| POST | ❌ | 创建两次就是两条记录 |

**这条性质直接决定重试策略**（Day 3 讲过）：POST 重试可能重复下单，必须配幂等键（`Idempotency-Key` 头）。

---

## 2. 统一响应结构

### 2.1 成功

```json
{
  "success": true,
  "data": { "...": "..." },
  "requestId": "0f3a-...",
  "timestamp": "2026-11-15T02:11:33.000Z"
}
```

### 2.2 失败

```json
{
  "success": false,
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "用户不存在",
    "details": null
  },
  "requestId": "0f3a-...",
  "timestamp": "2026-11-15T02:11:33.000Z"
}
```

### 2.3 每个字段的存在理由

| 字段 | 解决什么问题 | 谁在用 |
| --- | --- | --- |
| `success` | 判别字段，让前端 if 分支有类型 | 前端拦截器 |
| `data` | 成功数据与元信息分离 | 业务代码 |
| `error.code` | **程序判断**的稳定标识 | 前端分支逻辑 |
| `error.message` | **人看**的提示，可改文案 | 界面提示 |
| `error.details` | 字段级明细（校验错误数组） | 表单逐项标红 |
| `requestId` | 串联一次请求的所有日志 | 报障、排障 |
| `timestamp` | 服务端时间，避免客户端时钟不准 | 排查时序 |

**核心设计**：`code` 稳定、`message` 可变。前端**永远不要**用 `message` 做判断——文案一改，逻辑就崩。

### 2.4 为什么用拦截器 + 过滤器，而不是每个接口手写

- Controller 只返回业务数据（`return this.usersService.list(query)`），包装由 [response.interceptor.ts](../../apps/api/src/common/interceptors/response.interceptor.ts) 统一做。
- 异常由 [all-exceptions.filter.ts](../../apps/api/src/common/filters/all-exceptions.filter.ts) 统一归一化。

好处：**新增接口零成本获得统一结构**，不可能漏。

---

## 3. 错误码设计

### 3.1 命名规范

```
{资源}_{问题}
USER_NOT_FOUND
USER_EMAIL_DUPLICATED
AUTH_TOKEN_EXPIRED
MODEL_RATE_LIMITED
```

全大写、下划线、资源前缀。好处：`grep` 能搜、排序能分组、前端能穷举。

### 3.2 当前实现的不足（值得知道）

`all-exceptions.filter.ts` 里对 `HttpException` 的处理：

```ts
code: payload.error ?? 'HTTP_ERROR'
```

`payload.error` 来自 Nest 内置异常，值是 `'Bad Request'`、`'Not Found'` 这类**带空格的英文**，不是规范错误码。改进方向（第 2 周做）：

1. 在 Controller/Service 层统一抛 `AppError`，用自定义 code；
2. 或者加一层映射表：`BadRequestException + 'email'` → `VALIDATION_FAILED`；
3. 保持 `HTTP_ERROR` 只作为兜底。

### 3.3 HTTP 状态码与业务码的分工

| 层 | 谁看 | 例子 |
| --- | --- | --- |
| HTTP 状态 | 网关、监控、缓存、浏览器 | 400 / 404 / 500 |
| 业务 code | 业务代码 | `USER_NOT_FOUND` |

两者不是二选一，**都要给**：状态码给基础设施，code 给业务代码。

---

## 4. 日志

### 4.1 分级原则

| 级别 | 什么时候用 | 例子 |
| --- | --- | --- |
| `log` | 正常关键节点 | 服务启动、请求摘要 |
| `warn` | 可恢复但异常 | 重试成功、降级 |
| `error` | 需要人介入 | 5xx、数据库连不上 |
| `debug` | 开发期细节 | 请求体（注意脱敏） |

「能恢复的不算 error」——如果用 error 记录每次重试，告警会被噪音淹没。

### 4.2 三个必须

1. **必须带 `requestId`**：一次请求跨多个函数，靠它串起来。
2. **5xx 打堆栈，4xx 不打**：4xx 是客户端问题，不是 bug；全打堆栈会把日志淹掉。
3. **必须脱敏**：密码、token、`Authorization` 头、手机号、模型 key 一律不能进日志。

### 4.3 结构化日志（第 2 周升级）

```ts
this.logger.log(JSON.stringify({ event: 'user.created', userId, requestId }));
```

文本日志靠正则捞，JSON 日志能被 ELK / Loki 直接查询。

---

## 5. Swagger：文档即契约

### 5.1 三条装饰器

```ts
@ApiTags('users')                          // 分组
@ApiOperation({ summary: '用户列表' })      // 接口说明
@ApiOkResponse({ type: UserDto })          // 响应结构
```

DTO 上的 `@ApiProperty({ description: '邮箱', example: 'a@b.com' })` 会出现在文档的 schema 里。

### 5.2 子路径部署的坑（已踩过）

`SwaggerModule` 默认认为 API 在站点根路径 `/api`。部署到 `/lab/` 后，"Try it out" 会请求 `http://域名/api/users` → 404。解决：

```ts
swaggerBuilder.addServer('/lab');
```

这就是 [main.ts](../../apps/api/src/main.ts#L78-L83) 里 `SWAGGER_SERVER_URL` 的作用。

### 5.3 契约的更高价值：生成前端类型

OpenAPI JSON（`/docs-json`）可以被 `openapi-typescript` 转成 TS 类型：

```bash
npx openapi-typescript http://localhost:9527/docs-json -o src/api/schema.d.ts
```

第 2 周前端就能用后端定义的类型，**字段改名时前端编译报错**。这是"契约先行"的落地方式。

---

## 6. 调试工具

### 6.1 命令行看响应全貌

```powershell
# 只看 body
Invoke-RestMethod http://localhost:9527/api/users

# 看状态码 + 响应头（requestId 在这里）
Invoke-WebRequest http://localhost:9527/api/users -SkipHttpErrorCheck |
  Select-Object StatusCode, Headers

# 构造错误请求，看统一失败结构
Invoke-WebRequest -Method POST http://localhost:9527/api/users `
  -ContentType "application/json; charset=utf-8" `
  -Body '{"email":"not-an-email","name":"测试"}' -SkipHttpErrorCheck
```

### 6.2 用 requestId 追一次请求

1. 请求时自己带 `x-request-id: debug-001`；
2. 服务端日志里 `grep debug-001`，能看到所有相关行；
3. 响应头也回写了这个 ID，前端报障时可以直接给你。

**这是线上排障最快的手段**，比"你几点几分点的"靠谱得多。

### 6.3 断点调试

```json
// .vscode/launch.json
{
  "type": "node",
  "request": "launch",
  "name": "Debug API",
  "program": "${workspaceFolder}/apps/api/dist/main.js",
  "sourceMaps": true
}
```

先 `tsc` 构建，再启动，源码断点能对上——因为产物保留了 `sourceMap`。

---

## 7. 接口验收清单

| # | 检查项 | 期望 |
| --- | --- | --- |
| 1 | 成功响应结构 | `success:true` + `data` + `requestId` + `timestamp` |
| 2 | 失败响应结构 | `success:false` + `error.code/message` |
| 3 | 参数校验 | 非法 email → 400，`details` 是数组 |
| 4 | 资源不存在 | 404 + 明确 code |
| 5 | 状态码语义 | 不是所有响应都 200 |
| 6 | 响应头 | 有 `x-request-id` |
| 7 | 文档 | `/docs` 可访问，schema 正确 |
| 8 | 中文 | 请求/响应中文不乱码 |
| 9 | 日志 | 5xx 有堆栈，带 requestId |
| 10 | 脱敏 | 日志里没有密码/token |

---

## 8. 自测

1. 为什么 4xx 不打堆栈、5xx 要打？如果反过来会怎样？
2. 为什么前端不能用 `error.message` 做逻辑判断？
3. `POST /api/users` 能设计成幂等的吗？怎么实现？

## 9. 练习

**练习 1**：用 `Invoke-WebRequest -SkipHttpErrorCheck` 依次请求：合法 GET、非法 email POST、不存在的 id。记录三组状态码、`error.code`、响应头，填进上面的验收清单。

**练习 2**：设计一套错误码（至少 6 个），覆盖认证、用户、模型调用三类，并说明每个对应哪个 HTTP 状态码。

**练习 3**：给 `AllExceptionsFilter` 加一条 `warn` 日志，记录所有 4xx 的 `code` 和路径（不打堆栈），思考它有什么运维价值。

**练习 4**：用 `openapi-typescript` 从 `/docs-json` 生成类型，看看生成的 `User` 长什么样，与你手写的 `User` 有何差异。

## 10. 今日三行

- 今天解决了什么问题：
- 为什么这样设计：
- 还有什么不确定：
