# Day 2 笔记：TypeScript 服务端核心

> 日期：2026-11-13
> 对应计划：第 1 周 · Day 2 —— 类型收窄、泛型、联合类型、Utility Types、接口与 DTO
> 编码练习：实现 User、ChatMessage、ApiResponse 类型；泛型分页函数；类型安全的错误响应

## 0. 一句话总结

**类型是编译期的契约，不是运行时的保险。** 编译期它帮你挡住字段拼错、结构不符；编译之后它**全部消失**——所以"需要运行时校验"的地方，必须用 `class`，不能用 `interface`。

---

## 1. 三层认知：类型、校验、元数据

同一个 DTO，要同时满足三件事：

| 层 | 谁负责 | 依赖什么 |
| --- | --- | --- |
| 编译期类型检查 | `tsc` | `interface` / `type` / `class` 都行 |
| 运行时字段校验 | `class-validator` + `ValidationPipe` | **必须是 class**（装饰器挂在类属性上） |
| DI 参数类型推断 | NestJS 注入器 | **必须是 class** + `emitDecoratorMetadata` |

`interface` 只存在于编译期，编译后**一行代码都不剩**。所以：

```ts
// ❌ 运行时拿不到任何信息
interface CreateUserDto { email: string }

// ✅ 运行时是一个真实存在的类，装饰器、元数据、new 实例都靠它
class CreateUserDto {
  @IsEmail() email!: string;
}
```

> 这也是 Day 1 那道题的现实意义：`emitDecoratorMetadata` 关掉，第三层直接失效。

---

## 2. 联合类型与类型收窄

### 2.1 字面量联合：把"字符串"变成"枚举"

```ts
export type UserRole = 'admin' | 'member';      // user.entity.ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';  // chat-message.ts
```

好处：写错 `'admn'` 编译期就报错；编辑器能自动补全。

对比 `enum`：字面量联合**没有运行时代码**，更适合纯类型场景；需要反向映射或运行时遍历时才用 `enum`。

### 2.2 判别联合（discriminated union）

`api-response.ts` 的核心设计：

```ts
interface ApiSuccess<T> { success: true;  data: T; ... }
interface ApiFailure   { success: false; error: {...}; ... }
type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
```

两个成员有一个共同的**判别字段** `success`，且类型是**字面量** `true` / `false`（不是 `boolean`）。这让 TS 能根据 `if (body.success)` 自动收窄：

```ts
if (body.success) {
  body.data;   // ✅ 这里 body 是 ApiSuccess<T>
} else {
  body.error;  // ✅ 这里 body 是 ApiFailure
}
```

**关键点**：如果写成 `success: boolean`，收窄就失效了，`body.data` 和 `body.error` 都会报"可能不存在"。

### 2.3 收窄的五种手段

| 手段 | 例子 | 适用 |
| --- | --- | --- |
| `typeof` | `typeof body === 'string'` | 原始类型 |
| `instanceof` | `exception instanceof AppError` | 类实例 |
| `in` | `'data' in body` | 结构差异 |
| 判别字段 | `if (body.success)` | 联合类型（最推荐） |
| 自定义守卫 `is` | `function isAppError(e: unknown): e is AppError` | 复杂判断复用 |

`all-exceptions.filter.ts` 里的 `normalize()` 就是标准的**逐层收窄**：

```ts
if (exception instanceof AppError) { ... }        // 先判自定义错误
if (exception instanceof HttpException) { ... }   // 再判框架错误
return { status: 500, code: 'INTERNAL_ERROR' };   // 兜底
```

顺序很重要：**从具体到宽泛**。`HttpException` 的父类范围大，放前面会吞掉 `AppError`。

### 2.4 穷尽检查（exhaustive check）

```ts
function assertNever(x: never): never {
  throw new Error(`未处理的分支: ${JSON.stringify(x)}`);
}

function roleLabel(role: ChatRole): string {
  switch (role) {
    case 'system': return '系统';
    case 'user': return '用户';
    case 'assistant': return '助手';
    case 'tool': return '工具';
    default: return assertNever(role);  // 少写一个 case 就编译报错
  }
}
```

以后给 `ChatRole` 加 `'function'`，这里会立刻报错，逼你处理新分支。**这比"运行时才发现漏了"值钱得多。**

---

## 3. 泛型：让"输入类型"和"输出类型"产生关联

### 3.1 最基本的三处用法

```ts
interface ApiSuccess<T> { data: T }
interface Paginated<T> { items: T[] }
export function paginate<T>(items: T[], query: PaginationQuery): Paginated<T>
```

`paginate<User>(users, query)` 的返回值就是 `Paginated<User>`，`items[0].email` 有类型提示。

**如果没有 `<T>`**，只能写成 `Paginated<any>` 或 `Paginated<unknown>`——前者丢失类型安全，后者每次用都要断言。

### 3.2 泛型不是"随便填"，可以有约束

```ts
// 约束：T 必须有 id 字段
function indexById<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}
```

`extends` 在这里是"至少具备这些形状"，不是继承。

### 3.3 泛型默认值

```ts
interface ApiSuccess<T = unknown> { data: T }
```

调用方不关心具体类型时可以省略，避免到处写 `<unknown>`。

### 3.4 拦截器上的泛型

```ts
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown>
```

这里 `T` 表示"控制器返回的数据类型"，第二个参数 `unknown` 表示"包装后的类型"。用 `unknown` 而不是 `any`，是因为包装后结构变了，调用方不该假设原类型。

---

## 4. Utility Types：不写重复类型

| 工具 | 作用 | 实战场景 |
| --- | --- | --- |
| `Partial<T>` | 所有字段变可选 | 更新接口 `UpdateUserDto` |
| `Required<T>` | 所有字段变必填 | 内部补全默认值后 |
| `Pick<T,K>` | 挑几个字段 | `Pick<User,'id'\|'name'>` 做列表项 |
| `Omit<T,K>` | 去掉几个字段 | `Omit<User,'password'>` 对外返回 |
| `Readonly<T>` | 全部只读 | 配置对象、常量表 |
| `Record<K,V>` | 键值映射 | 错误码 → HTTP 状态 |
| `Exclude<U,E>` | 联合里去掉成员 | 从角色里排除 `guest` |
| `Extract<U,E>` | 只保留成员 | 只取管理类角色 |
| `NonNullable<T>` | 去掉 null/undefined | 处理后端必填字段 |
| `ReturnType<F>` | 取函数返回类型 | 复用 service 方法类型 |
| `Parameters<F>` | 取函数参数元组 | 包装函数时 |

第 2 周做"更新用户"时的标准写法：

```ts
// 邮箱是登录标识，不允许通过更新接口修改
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 50)
  name?: string;

  @IsOptional() @IsIn(['admin', 'member'])
  role?: UserRole;
}
```

用类型压缩表达就是 `Partial<Omit<CreateUserDto, 'email'>>`——但 **DTO 必须写成 class 才能加装饰器**，所以 Utility Types 主要用于**内部类型推导**，不直接当 DTO 用。

其他常见组合：

```ts
type PublicUser = Omit<User, 'email'>;              // 对外脱敏
type UserMap = Record<string, User>;                // 按 id 索引
type ErrorStatusMap = Record<string, number>;       // 错误码映射
```

---

## 5. interface / type / class 怎么选

| 用哪个 | 场景 | 本项目例子 |
| --- | --- | --- |
| `interface` | 描述对象结构，可能被扩展/合并 | `User`、`ChatMessage`、`Paginated<T>` |
| `type` | 联合、交叉、工具类型、别名 | `UserRole`、`ChatRole`、`ApiResponse<T>` |
| `class` | 需要运行时存在：装饰器、new、instanceof | `CreateUserDto`、`AppError`、各类 Controller/Service |

一条实用判断：**"运行时还需要它吗？"** 需要 → `class`；不需要 → `interface` / `type`。

补充差异：

- `interface` 支持**声明合并**（同名接口自动合并），`type` 不支持。
- `type` 能表达联合/元组/条件类型，`interface` 不能。
- 团队约定：对象结构优先 `interface`，其余用 `type`。

---

## 6. DTO 的两个语法细节

### 6.1 `!` 确定赋值断言

```ts
export class CreateUserDto {
  @IsEmail()
  email!: string;   // 注意这个 !
}
```

`strict` 模式下，类属性必须初始化。但 DTO 的字段是**运行时有值、编译期由外部填充**，所以用 `!` 告诉 TS："别管，肯定有值。"

它**不做任何运行时检查**——真没值照样是 `undefined`。真正的保证来自 `ValidationPipe`。

### 6.2 `?` 可选字段

```ts
@IsOptional()
@IsIn(['admin', 'member'])
role?: 'admin' | 'member';
```

`?` 让类型变成 `'admin' | 'member' | undefined`，同时 `@IsOptional()` 让校验器跳过它。

二者必须配套：只有 `?` 没有 `@IsOptional()`，传 `undefined` 会校验失败；只有 `@IsOptional()` 没有 `?`，类型上仍要求必填。

---

## 7. 类型安全的错误响应

`AppError` 为什么是 class：

```ts
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get retryable(): boolean {
    return this.status >= 500 || this.code === 'RATE_LIMITED';
  }
}
```

四个设计点：

1. **继承 `Error`**：能拿到 `stack`，能用 `instanceof`，能被 `throw`。
2. **`readonly`**：错误一旦创建就不可变，避免链路上被意外篡改。
3. **`code` 稳定不变**：前端按 code 分支处理，不依赖会变的中文文案。
4. **`retryable` getter**：把"要不要重试"的判断收进错误自身，调用方不用记规则。第 3 周接模型调用时直接用。

对比"返回 `{ error: 'USER_NOT_FOUND' }` 对象"：对象没法 `throw`，也没法 `instanceof`，更没法携带 stack。

### unknown vs any

```ts
catch(exception: unknown, host: ArgumentsHost)
```

用 `unknown` 而不是 `any`：**必须先收窄才能使用**。`any` 会让你直接写 `exception.message`，运行时才发现是字符串。`unknown` 逼你写 `instanceof` 判断——这就是类型安全。

---

## 8. 声明合并：给第三方类型加字段

`express.d.ts`：

```ts
declare module 'express' {
  interface Request {
    requestId: string;
  }
}
```

- 为什么能这么写：`interface` 支持声明合并，同名接口自动叠加。
- 为什么必须是 `.d.ts` 且被 `tsconfig.include` 覆盖：只有被编译器加载的声明文件才生效。
- 后果：中间件里 `req.requestId = xxx`、拦截器里 `request.requestId` 都不再报错。

---

## 9. 今日自测

1. 为什么 `CreateUserDto` 不能写成 `interface`？说出一条**运行时**的理由。
2. `Paginated<T>` 里的 `<T>` 去掉后，前端调用处会失去什么？
3. `exception instanceof AppError` 和 `(exception as AppError).code === 'X'` 有什么区别？后者有什么风险？

## 9.1 我的答题与修正（2026-11-13）

**第 1 题：为什么 DTO 不能是 interface？**

- 我的答案：interface 只存在于编译期，运行时代码不存在。（方向对，但只说了一半）
- 补充要点：要说出"运行时**谁**需要它"：
  1. `@IsEmail()` 这类**属性装饰器**只能挂在 class 成员上，interface 没有运行时对象；
  2. `ValidationPipe` 依赖 `design:paramtypes` 元数据拿到 `metatype`，而 tsc **只对 class 类型的参数**输出该元数据；
  3. `class-transformer` 需要 `new` 出实例才能把 query 字符串转成数字。
- 结论：没有 class → 校验链整条失效，`@Body()` 原样放行脏数据。

**第 2 题：`Paginated<T>` 去掉 `<T>` 会失去什么？**

- 我的答案：失去灵活性，不能代码提示、不能检测错误。（"失去灵活性"不准确）
- 修正：泛型不是增加灵活性，而是**用一处灵活性换取整条链路的类型安全**。去掉后只能写成 `Paginated<any>` 或 `Paginated<unknown>`：
  - `items[0].emial`（拼错）不报错；
  - 属性没有补全；
  - `any` 会向下游扩散（传给 `render(u: User)` 也不报错），污染整个调用链；
  - 重构重命名字段时，编译器无法帮你找调用点。

**第 3 题：`instanceof` 与 `as` 断言的区别？**

- 我的答案：不知道。
- 修正：`as` 是**只对编译器生效的"闭嘴"指令，运行时零检查**。
  - 异常可能是 `string`、普通 `Error`、甚至 `null`；`(exception as AppError).code` 在 `null` 上会直接抛 `TypeError`，而这段代码正处在异常过滤器内部——异常处理时再抛异常，会破坏统一响应结构；
  - 即使不崩，拿到的 `code` 也是 `undefined`，前端收到 `error.code: undefined`，接口契约被破坏；
  - `instanceof` 是**运行时构造器检查**，检查通过的同时完成类型收窄，两个作用一次完成。
- 一句话记忆：**断言是你对编译器的承诺，守卫是编译器对你的检查。**

## 10. 练习

**练习 1（判别联合 + 收窄）**：不落文件，在纸上/心里写：

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
function unwrap<T>(r: Result<T>): T { /* 用 if (r.ok) 收窄 */ }
```

**练习 2（穷尽检查）**：在 `chat-message.ts` 里给 `ChatRole` 加一个 `'function'`，然后写一个 `switch` + `assertNever` 的函数，观察 TS 是否报错；改回原样。

**练习 3（Utility Types）**：写出 `UpdateUserDto` 的**两个版本**：
- 版 A：`Partial<Omit<CreateUserDto, 'email'>>`（纯类型）
- 版 B：class + 装饰器（可校验）

思考：为什么最终必须用版 B？

**练习 4（收窄顺序）**：把 `all-exceptions.filter.ts` 里 `AppError` 和 `HttpException` 两个 `if` 调换顺序（`AppError` 不是 `HttpException` 子类，实际不会出错，但请解释"如果它俩有继承关系，顺序会怎样影响结果"）。

## 11. 今日三行

- 今天解决了什么问题：
- 为什么这样设计：
- 还有什么不确定：
