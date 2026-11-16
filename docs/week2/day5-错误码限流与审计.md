# 第 2 周 Day 5 笔记：错误码规范化、登录限流与审计日志

> 目标：让接口"对机器友好、对攻击者不友好、对排查友好"。

---

## 一、错误码规范化

### 问题

Nest 内置异常返回的 `error` 字段是英文短语：

```json
{"statusCode": 400, "message": ["..."], "error": "Bad Request"}
```

`"Bad Request"` 带空格、大小写混排，前端只能写 `if (code === 'Bad Request')`，且改不了、grep 不便。

### 方案

状态码 → 稳定错误码，在过滤器里统一映射：

| 状态码 | code |
|---|---|
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 422 | `UNPROCESSABLE_ENTITY` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

约定：**全大写 + 下划线 + 可穷举**。前端按 code 分支，message 只用于展示（会变、会多语言）。

### 一个容易漏的分支

`HttpException` 有两种响应形态：

```ts
new HttpException('随便一句话', 429)                  // getResponse() 返回 string
new HttpException({ message: '...' }, 429)           // 返回对象
```

过滤器里两个分支都要映射，否则限流返回的 code 会是旧的 `HTTP_ERROR`（本项目第一版就漏了，实测才发现）。

---

## 二、登录限流

### 为什么必须有

没有限流，6 位数字密码 100 万种组合，脚本跑几分钟就能撞开。argon2 让每次尝试变慢（~50ms），但只靠它仍不够——攻击者可以分布式打。

### 设计

| 项 | 选择 | 理由 |
|---|---|---|
| 计数 key | `IP + 邮箱` | 同时防「一机撞多号」和「多机撞一号」 |
| 只计失败 | 成功即清零 | 否则正常用户多次登录会被锁 |
| 窗口 | 15 分钟 | 可配置 `LOGIN_WINDOW_MS` |
| 上限 | 5 次 | 可配置 `LOGIN_MAX_ATTEMPTS` |
| 状态码 | 429 | 语义就是"请求过多" |

### 位置：Guard，不是 Pipe

Guard 在 Pipe 之前、也在 argon2 之前执行——**被锁的请求根本不会消耗 50ms 的哈希计算**。这是"越早拦截越省资源"的典型应用。

### 分工要清晰

```ts
// Guard：只检查，不算账
this.attempts.assertAllowed(key);
request.loginKey = key;   // 挂到请求上，Service 用同一个 key

// Service：登录失败才计数，成功就清零
if (failed) this.attempts.recordFailure(loginKey);
else this.attempts.reset(loginKey);
```

key 由 Guard 算一次挂到 `req.loginKey`，避免两边算法不一致导致"锁了 A 却记了 B"。

### 内存实现的边界

当前用 `Map` 存在进程内：
- 单实例开发环境：够用；
- 多实例 / Serverless：**每个实例各算各的，限流形同虚设**，必须换 Redis（`INCR` + `EXPIRE`）。

这条要写进技术债，别在扩容时才发现。

---

## 三、审计日志

审计日志要回答三个问题：**谁、做了什么、结果如何**。

当前实现（结构化文本，便于 grep）：

```
auth.register.success userId=cmwj9...
auth.login.success userId=cmwj9... role=ADMIN
auth.login.failed email=locktest@example.com attempts=3 userId=none
auth.refresh.success userId=cmwj9...
auth.logout userId=cmwj9...
```

三条纪律：

1. **绝不记录密码、Token 原文**。只记 userId / email / 结果 / 次数。
2. **4xx 用 `warn`，5xx 用 `error`**。否则用户输错密码就能触发告警，真正的事故被淹没。
3. **事件名用点号分层**（`auth.login.failed`），方便按前缀统计成功率。

---

## 四、实测结果

### 错误码

| 场景 | 状态 | code |
|---|---|---|
| 注册参数非法 | 400 | `BAD_REQUEST` |
| 密码错误 | 401 | `UNAUTHORIZED` |
| 邮箱重复 | 409 | `CONFLICT` |
| 登录失败超限 | 429 | `RATE_LIMITED` |

### 限流

```
第 1 次: 401 UNAUTHORIZED 邮箱或密码错误
第 2 次: 401 UNAUTHORIZED
第 3 次: 401 UNAUTHORIZED
第 4 次: 401 UNAUTHORIZED
第 5 次: 401 UNAUTHORIZED
第 6 次: 429 RATE_LIMITED 登录尝试过于频繁，请 900 秒后再试
```

并且：正常账号 `carol` 登录 **200**，没被误伤（key 不同）。

### 审计日志（服务端输出）

```
WARN  auth.login.failed email=locktest@example.com attempts=5 userId=none
LOG   auth.login.success userId=cmwj9... role=ADMIN
```

---

## 五、踩坑记录

1. **限流返回的 code 仍是 `HTTP_ERROR`**：`HttpException(字符串)` 走的是过滤器的 string 分支，漏改就会不一致。
2. **限流窗口文案**：显示"900 秒后再试"是窗口全长，不是剩余时间——首次锁定时的正确行为，但用户看到会觉得久，后续可优化为剩余时间（本实现已用 `resetAt - now`，锁定期间会递减）。
3. **测试脚本用 Node 而不是 PowerShell**：避免 `"Bearer $obj.token"` 只展开 `$obj` 的插值陷阱（Day 4 踩过）。

---

## 六、技术债

| 项 | 说明 |
|---|---|
| 限流状态在内存 | 多实例需 Redis |
| 审计日志只到 stdout | 生产应落库或接日志平台，并带 `requestId`、IP |
| 无全局速率限制 | 目前只限登录，其它接口仍可被刷 |
| 错误码未细分业务 | 例如 `USER_NOT_FOUND`、`AUTH_TOKEN_EXPIRED`，现在还是通用码 |

---

## 七、自测题

1. 为什么限流只统计失败次数？如果成功也计数，会出现什么问题？
2. 429 和 403 对客户端重试策略有什么不同要求？
3. 为什么审计日志里绝对不能记录 Token 原文，即使它"反正会过期"？

---

## 八、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
