# Day 4 笔记：NestJS 基础

> 日期：2026-11-13
> 对应计划：第 1 周 · Day 4 —— Module、Controller、Provider、依赖注入、DTO、Pipe
> 编码练习：/health、/users、/config 三组接口 + DTO 校验

## 0. 一句话总结

NestJS 解决的核心问题是 **"谁依赖谁、谁来创建、什么时候销毁"**。模块是边界，Provider 是可被容器创建的对象，Controller 是 HTTP 入口，DI 容器负责把依赖图连起来。

---

## 1. 手工 new 的灾难（为什么需要 DI）

```ts
// ❌ 没有 DI 的世界
const config = new ConfigService();
const userRepo = new UserRepository(config);
const usersService = new UsersService(userRepo, config);
const controller = new UsersController(usersService);
```

问题：

1. **顺序必须人工维护**：依赖变了，new 的顺序就得改。
2. **无法替换**：测试时想换 mock 的 `UserRepository`，得改源码。
3. **无法共享实例**：每个请求 new 一次？数据库连接池就爆了。
4. **循环依赖**：A 依赖 B、B 依赖 A，直接死锁。

DI 容器就是把这个"手工装配"变成一个**注册表**。

### 1.1 DI 的三个概念

| 概念 | 含义 | 本项目对应 |
| --- | --- | --- |
| Token | 依赖的唯一标识，通常就是类本身 | `UsersService` 这个类 |
| Provider | 告诉容器"这个 token 怎么造出实例" | `providers: [UsersService]` |
| Consumer | 声明自己要什么 | `constructor(private svc: UsersService)` |

### 1.2 容器怎么知道参数要注入什么

```ts
constructor(private readonly healthService: HealthService) {}
```

编译后会有：

```js
__metadata("design:paramtypes", [HealthService])
```

容器读这份元数据，拿到 `HealthService` 这个类作为 token，去注册表里找实例。**这就是 Day 1 实验里那个 `emitDecoratorMetadata` 的作用。**

> 如果类型是 `interface`，编译后没有运行时对象，**无法作为 token**——所以依赖注入的依赖项必须是 class（或用字符串/`Symbol` 显式 token）。

### 1.3 作用域（scope）

默认 **singleton**：整个应用只有一个实例，所有请求共享。

```ts
@Injectable()                                   // 默认 singleton
@Injectable({ scope: Scope.REQUEST })           // 每个请求一个实例
@Injectable({ scope: Scope.TRANSIENT })         // 每个消费者一个实例
```

**重要陷阱**：singleton 里**不能存请求级状态**。

```ts
@Injectable()
export class ChatService {
  private currentUserId!: string;   // ❌ 所有请求共享，会串号

  handle(userId: string) {
    this.currentUserId = userId;    // A 用户刚设置，B 用户请求就覆盖了
    return this.callModel();
  }
}
```

正确做法：状态作为**参数**传递，或用 `Scope.REQUEST`（有性能代价，慎用）。

---

## 2. 模块（Module）：边界与装配

```ts
// health.module.ts
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
```

```ts
// users.module.ts
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],   // 比其他模块多这一行
})
export class UsersModule {}
```

### 2.1 四件套

| 字段 | 作用 | 省略的后果 |
| --- | --- | --- |
| `imports` | 依赖的其他模块 | 注入不到对方 exports 的 Provider |
| `controllers` | HTTP 入口 | 路由不存在（404） |
| `providers` | 可被本模块注入的实例 | `Nest can't resolve dependencies` |
| `exports` | 对外暴露的 Provider | 其它模块能看到模块，但注入不到服务 |

### 2.2 模块边界的真实含义

- **provider 默认是模块私有的**，只有写进 `exports` 才能被外部使用。
- `HealthModule` 不写 `exports`，因为 `HealthService` 只给自己用。
- `UsersModule` 写了 `exports: [UsersService]`，是为了第 2 周的 `AuthModule` 能注入它查用户。

这就是**封装**：模块不是文件夹，是**可见性边界**。

### 2.3 全局模块

```ts
@Global()
@Module({ providers: [ConfigService], exports: [ConfigService] })
export class ConfigModule {}
```

`ConfigModule.forRoot({ isGlobal: true })` 就是全局的，所以任何模块都能直接注入 `ConfigService`，不用 imports。

---

## 3. 根模块与加载顺序

`AppModule` 的 `imports` 是**依赖图的起点**：

```
AppModule
├── ConfigModule（isGlobal）
├── HealthModule → HealthController → HealthService
├── UsersModule  → UsersController  → UsersService
└── SystemModule → SystemController → SystemService
```

启动日志里能看到这个过程：

```
[InstanceLoader] AppModule dependencies initialized
[InstanceLoader] HealthModule dependencies initialized
[RoutesResolver] HealthController {/api/health}
[RouterExplorer] Mapped {/api/health, GET} route
```

**先初始化模块和 Provider，再注册路由**。所以 Provider 的构造顺序是拓扑序——被依赖的先创建。

---

## 4. 请求生命周期：7 个阶段

```
请求
 ↓
① Middleware         requestIdMiddleware：分配 requestId
 ↓
② Guards             权限校验（第 2 周 JWT 会用）
 ↓
③ Interceptors(前)   记录开始时间、打日志
 ↓
④ Pipes              ValidationPipe：转换 + 校验 DTO
 ↓
⑤ Controller         只负责接参、调 Service
 ↓
⑥ Service            业务逻辑
 ↓
⑦ Interceptors(后)   ResponseInterceptor：包装统一结构
 ↓
响应（异常时走 ExceptionFilter）
```

本项目已用到的：

- ① `requestIdMiddleware`（[request-id.middleware.ts](../../apps/api/src/common/middleware/request-id.middleware.ts)）
- ④ `ValidationPipe`（main.ts 全局注册）
- ⑦ `ResponseInterceptor` + `AllExceptionsFilter`

第 2 周加鉴权时，Guard 插在 ② 的位置——**它比 Pipe 更早执行**，所以未登录请求不会进入参数校验。

---

## 5. Pipe：转换 + 校验

### 5.1 ValidationPipe 做了两件事

```ts
new ValidationPipe({
  whitelist: true,              // 剥离 DTO 未声明的字段
  transform: true,              // 转成 DTO 实例
  forbidNonWhitelisted: true,   // 多传字段直接 400
  transformOptions: { enableImplicitConversion: false },  // 必须显式 @Type
})
```

| 阶段 | 做什么 | 例子 |
| --- | --- | --- |
| transform | 原始 JSON → DTO 实例 | `{page:"2"}` → `ListUsersQueryDto { page: 2 }` |
| validate | 按装饰器规则校验 | `@IsEmail()` 不通过 → 400 |

**顺序很重要**：先转换再校验，否则 `page` 是字符串 `"2"`，`@IsInt()` 会失败。

### 5.2 三种 Pipe

| 类型 | 例子 | 用途 |
| --- | --- | --- |
| 内置 | `ParseIntPipe`、`ParseUUIDPipe` | 单个参数转换 |
| 全局 | `app.useGlobalPipes(new ValidationPipe())` | 全站 DTO 校验 |
| 自定义 | `@Injectable() class TrimPipe implements PipeTransform` | 特殊处理（去空格、脱敏） |

自定义 Pipe 示例：

```ts
@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return typeof value === 'string' ? value.trim() : value;
  }
}

// 用法：@Query('keyword', TrimPipe) keyword?: string
```

### 5.3 为什么 DTO 校验要在 Pipe 层

- 在 Controller 里写 `if (!email.includes('@'))` → 每个接口重复，且容易漏。
- 在 Service 里校验 → 业务逻辑被校验代码淹没，且 Service 可能被内部调用（不经过 HTTP）。
- 放在 Pipe → **入口统一拦截**，Service 拿到的永远是干净数据（"信任内部输入"原则）。

---

## 6. Controller 薄，Service 厚

```ts
// users.controller.ts
@Get()
list(@Query() query: ListUsersQueryDto): Paginated<User> {
  return this.usersService.list(query);   // 一行，只做转发
}
```

```ts
// users.service.ts
list(query: ListUsersQueryDto): Paginated<User> {
  const keyword = query.keyword?.trim().toLowerCase();
  const filtered = keyword ? this.users.filter(...) : this.users;
  return paginate(filtered, query);
}
```

理由：

1. **可测试**：Service 不依赖 HTTP，可以直接单测。
2. **可复用**：第 2 周 AuthService 也要查用户，直接注入 UsersService。
3. **可替换**：第 2 周把内存数组换 Prisma，Controller 一行都不用改。

**方法签名就是契约**：`list / findById / create` 保持稳定，内部实现随便换。

---

## 7. 常见报错对照表

| 报错 | 原因 | 修复 |
| --- | --- | --- |
| `Nest can't resolve dependencies of X (?)` | Provider 没注册 / 没 exports / 没 imports | 检查三层：providers → exports → imports |
| `Cannot find module './xxx'` | 路径错 / 文件没建 | 检查相对路径 |
| 路由 404 但 Controller 写了 | 模块没进 AppModule.imports | 加进 imports |
| DTO 校验不生效 | 参数类型是 interface / 没加 @Body() / 全局 Pipe 没注册 | 检查元数据与装饰器 |
| `@Inject` 报 token 找不到 | 自定义 token 没在 providers 注册 | `{ provide: TOKEN, useValue: ... }` |

---

## 8. 自测

1. `@Injectable()` 加上之后，Nest 到底多知道了什么？不加会怎样？
2. `providers: [UsersService]` 和 `exports: [UsersService]` 各自解决什么问题？只写前者，AuthModule 能注入吗？
3. 为什么 Controller 里不应该写业务逻辑？说出两个具体后果。

## 9. 练习

**练习 1（模块边界）**：假设新建 `AuthModule`，它 `imports: [UsersModule]` 并注入 `UsersService`。如果把 `UsersModule` 的 `exports` 去掉，会发生什么？报错发生在启动时还是请求时？

**练习 2（单例陷阱）**：给 `UsersService` 加一个实例字段 `private lastQuery = ''`，在 `list()` 里赋值。用两个不同 `?keyword=` 并发请求，观察是否互相影响，并解释原因。

**练习 3（自定义 Pipe）**：写一个 `TrimPipe`，用在 `@Query('keyword')` 上，验证前后空格被去掉。

**练习 4（流程顺序）**：给 `UsersController` 临时加一个 `@UseGuards()` 抛 401，然后发一个 email 非法的 POST 请求。观察返回的是 401 还是 400，并解释为什么。

## 10. 今日三行

- 今天解决了什么问题：
- 为什么这样设计：
- 还有什么不确定：
