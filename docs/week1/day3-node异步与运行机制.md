# Day 3 笔记：Node.js 异步与运行机制

> 日期：2026-11-13
> 对应计划：第 1 周 · Day 3 —— Promise、async/await、事件循环、流、Buffer、异常传播
> 编码练习：并发请求控制器；超时、重试、统一异常捕获
> 教材：[concurrency.ts](../../apps/api/src/common/utils/concurrency.ts)

## 0. 一句话总结

**Node 是单线程执行 JS，但靠事件循环在等待 I/O 时切换任务。** 理解这一点，才能理解"为什么 `await` 不会阻塞进程，但一段 `while` 会"。

---

## 1. 实验：事件循环的真实优先级

脚本（临时文件，跑完即删）：

```js
console.log('1 sync start');
setTimeout(() => console.log('5 setTimeout(0)'), 0);
setImmediate(() => console.log('4 setImmediate'));
Promise.resolve().then(() => console.log('3 promise.then'));
process.nextTick(() => console.log('2 process.nextTick'));
console.log('1 sync end');
```

实测输出：

```
[   0ms] 1 sync start
[   4ms] 1 sync end
[   5ms] 2 process.nextTick
[   5ms] 3 promise.then
[   5ms] 5 setTimeout(0)
[   5ms] 4 setImmediate
```

### 1.1 三条规则

1. **同步代码永远最先跑完**，包括 `Promise` 构造函数里的 executor。
2. **微任务队列每轮清空**：`process.nextTick` → `Promise.then`（nextTick 优先级更高，它有自己的队列，在每个阶段切换前执行）。
3. **宏任务一次取一个**：`setTimeout` / `setInterval` / I/O / `setImmediate`。

### 1.2 两个容易踩的点

- **`setTimeout(fn, 0)` 不是 0ms**。它表示"至少 0ms 后放进 timers 队列"，实际执行取决于事件循环何时空闲。实测 `sync end` 用了 4ms，timer 就在 4ms 之后。
- **主模块里 `setTimeout(0)` 与 `setImmediate` 顺序不确定**。本次实测 setTimeout 先；但在 I/O 回调内部，`setImmediate` 必定先于 `setTimeout`。**不要在业务代码里依赖这两者的相对顺序。**

### 1.3 `await` 到底挂起了什么

```ts
async function a() {
  console.log('A1');
  await sleep(100);
  console.log('A2');   // 100ms 后执行，但期间进程能处理其它请求
}
```

- `await` 挂起的是**当前函数的执行**，把后续代码放进微任务，**进程不阻塞**。
- 真正的阻塞来自 **CPU 密集的同步代码**：

```ts
// ❌ 这 500ms 内整个服务无法响应任何请求
for (let i = 0; i < 5e9; i++) {}
```

解决方案：拆分任务让出事件循环、用 `worker_threads`、或者交给外部服务。

> 面试高频：**"Node 是单线程"指的是 JS 执行线程单线程**，I/O 由 libuv 线程池 + 操作系统异步能力完成。所以"单线程"不等于"低并发"。

---

## 2. 实验：超时保护 `withTimeout`

```ts
const slow = new Promise((resolve) => setTimeout(() => resolve('ok'), 200));
await withTimeout(slow, 100, '模型响应超时');
```

实测：

```
[ 134ms] 2 withTimeout -> 模型响应超时
[ 227ms]    slow task 自己跑完了（说明超时并没有取消它）
```

### 2.1 三个必须理解的点

1. **计时不精确**：设 100ms，实际 134ms。`setTimeout` 只是"最早时间"，事件循环忙时会延后。
2. **超时不等于取消**：`Promise.race` 只是**丢弃结果**，原任务仍在后台跑完。业务后果很严重：
   - 模型调用已经计费，钱花了；
   - 已经在写库的操作会继续写完；
   - 客户端已收到超时，服务端却产生了副作用。
3. **必须清 timer**：`finally` 里 `clearTimeout`，否则短任务也要等满超时才释放计时器，高并发下累积成泄漏。

### 2.2 真正取消：AbortController

```ts
async function withTimeoutAbort<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
```

`fetch(url, { signal })` 会真正中断连接。第 3 周调用模型 SDK 时优先用它。

---

## 3. 实验：并发受限 `runWithConcurrency`

```ts
await runWithConcurrency([1,2,3,4,5,6], 2, async (n) => {
  await sleep(100);
  return n * 10;
});
```

实测：**结果 `[10,20,30,40,50,60]`，峰值并发 2，耗时 327ms**。

### 3.1 三种策略对比

| 策略 | 6 个 100ms 任务耗时 | 峰值并发 | 风险 |
| --- | --- | --- | --- |
| 串行 `for await` | ~600ms | 1 | 慢 |
| `Promise.all` | ~100ms | 6 | 触发限流、打爆内存 |
| `runWithConcurrency(limit=2)` | ~327ms | 2 | 无（可控） |

### 3.2 为什么 cursor 不需要锁

```ts
const index = cursor;
cursor += 1;
results[index] = await worker(items[index], index);
```

这两行是**同步执行**的，中间没有 `await`，所以不会被打断。JS 单线程 + 无 await 区间 = 天然原子。**一旦你在 `cursor += 1` 之前插了 `await`，并发就会出错**——这是很多人写并发池时的经典 bug。

### 3.3 为什么 `results` 要预分配

`new Array(items.length)` + `results[index] = ...`，保证**结果顺序与输入一致**，与完成先后无关。如果直接 `push`，结果顺序就是完成顺序，调用方拿到的数据会错位。

### 3.4 用在哪

- 批量调用模型：同时最多 5 个请求，避免触发 RPM 限流。
- 批量 embedding：一次处理 100 条文本，限制并发 10。
- 批量抓网页 / 批量写库。

---

## 4. 实验：指数退避重试 `withRetry`

```ts
await withRetry(fn, { retries: 3, baseDelayMs: 50 });
// 第 1 次失败等 50ms，第 2 次失败等 100ms，第 3 次失败等 200ms
```

实测：失败两次后成功，**尝试 3 次，耗时 170ms**（50 + 100 + 开销）。

### 4.1 为什么要指数退避

外部服务过载时，所有客户端**同时**重试会造成"重试风暴"，把刚恢复的服务再打死。退避让请求分散开。

**它还缺一个东西：jitter（随机抖动）**。多个客户端按固定 50/100/200ms 重试，仍会形成整齐的波峰。标准做法：

```ts
const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
const jittered = delay * (0.5 + Math.random() * 0.5);  // 0.5x ~ 1x
```

### 4.2 不是所有错误都该重试

```ts
shouldRetry: (error) => error instanceof AppError && error.retryable
```

- ✅ 网络超时、5xx、429 限流 → 重试
- ❌ 400 参数错误、401 未登录、404 不存在 → 重试一万次也一样

这正好用上 Day 2 的 `AppError.retryable` getter。

### 4.3 两个坑

1. **非幂等操作不能随便重试**：POST 创建订单重试可能创建两单。需要幂等键（idempotency key）。
2. **重试会放大延迟**：`withTimeout` 应该包在**单次尝试**外层还是整体外层？通常单次超时 + 整体重试，总耗时上限 = `(timeout + backoff) * (retries + 1)`。

---

## 5. Promise 四兄弟

| API | 成功条件 | 失败行为 | 典型场景 |
| --- | --- | --- | --- |
| `Promise.all` | 全部成功 | 任一失败立即 reject，**其它任务不会停止** | 强依赖：少一个就无法继续 |
| `Promise.allSettled` | 总是 resolve | 返回 `{status, value/reason}` 数组 | 批量任务，允许部分失败 |
| `Promise.race` | 第一个 settle | 第一个失败就 reject | 超时控制 |
| `Promise.any` | 第一个成功 | 全部失败才 reject（AggregateError） | 多源容灾、多个镜像取最快 |

注意 `Promise.all` 的"失败不停止"：其它 Promise 仍在跑，副作用照样发生。

---

## 6. 异常传播

### 6.1 async 函数抛错 = 返回 rejected Promise

```ts
async function f() {
  throw new Error('boom');   // 等价于 return Promise.reject(...)
}
f();                          // 不 await 也不 catch → unhandledRejection
```

### 6.2 `try/catch` 只能捕获 `await` 的 rejection

```ts
// ❌ 捕获不到：没有 await，错误发生在另一个微任务里
try {
  doAsync();
} catch (e) {}

// ✅
try {
  await doAsync();
} catch (e) {}
```

### 6.3 在 NestJS 里的统一捕获

控制器里 `throw new AppError(...)` → Nest 捕获 → `AllExceptionsFilter` 归一化 → 统一失败结构。**不要在 service 里 `res.json(500)`**，那会绕过整条拦截链。

`main.ts` 里的全局管道/拦截器/过滤器顺序也是靠事件循环串起来的，Day 5 会细讲。

---

## 7. 流（Stream）与 Buffer

### 7.1 为什么 AI 场景必须用流

| 方式 | 首个字符到达时间 | 内存占用 | 体验 |
| --- | --- | --- | --- |
| 一次性返回 | 等全部生成完 | 整个响应在内存 | 长回答要白屏十几秒 |
| 流式（SSE） | 第一个 token 立即到达 | 按块处理 | 打字机效果 |

第 3 周的 `/api/chat` 会用 **SSE（`text/event-stream`）**把模型输出逐块推给前端。

### 7.2 Buffer 是什么

- Node 里处理二进制数据的容器（底层是 `Uint8Array`）。
- 读文件、收网络包拿到的都是 Buffer；转文本要指定编码：`buf.toString('utf8')`。
- 字符串拼接可能截断多字节字符（中文、emoji），**流式处理时要用 `StringDecoder`**，这是中文场景的经典 bug。

### 7.3 背压（backpressure）

生产速度 > 消费速度时，数据会堆在内存里。`pipe()` 会自动处理背压（写不进去就暂停读），手动 `data` 事件监听则不会。第 3 周写 SSE 时要注意"客户端断开"的处理，否则会一直往已关闭的连接写。

---

## 8. 自测

1. 为什么 `process.nextTick` 比 `Promise.then` 先执行？
2. `withTimeout` 超时后原任务仍在跑，会带来哪些业务风险？怎么真正取消？
3. `Promise.all([a, b, c])` 中 `b` reject 之后，`a` 和 `c` 会停止吗？

## 9. 练习

**练习 1**：把 `runWithConcurrency` 的 `limit` 分别改成 1、3、6，记录耗时，验证"耗时 ≈ ceil(数量/并发) × 单任务耗时"。

**练习 2**：给 `withRetry` 加 jitter，改成 `delay * (0.5 + Math.random() * 0.5)`，并解释为什么这样做能减少重试风暴。

**练习 3**：用 `AbortController` 改造 `withTimeout`，让超时真正中断 `fetch`。

**练习 4（组合题）**：写一个函数，批量处理 20 个用户，要求：最多 5 并发、单次超时 500ms、失败重试 2 次、部分失败不影响其它、最后返回成功列表和失败列表。提示：`runWithConcurrency` + `withRetry` + `withTimeout` + `Promise.allSettled` 组合。

## 10. 今日三行

- 今天解决了什么问题：
- 为什么这样设计：
- 还有什么不确定：
