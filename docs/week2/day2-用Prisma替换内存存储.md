# 第 2 周 Day 2 笔记：用 Prisma 替换内存存储

> 目标：`GET/POST /api/users` 的数据从 PostgreSQL 读写，API 契约（响应结构、字段名、错误语义）保持不变。

---

## 一、改动清单

| 文件 | 改动 |
|---|---|
| `src/prisma/prisma.service.ts` | 新增：封装 PrismaClient，接入 Nest 生命周期 |
| `src/prisma/prisma.module.ts` | 新增：`@Global()` 全局模块 |
| `src/app.module.ts` | 新增：`imports: [PrismaModule]` |
| `src/modules/users/users.service.ts` | 重写：内存数组 → Prisma 查询 |
| `src/modules/users/users.controller.ts` | 返回类型 `User` → `Promise<User>` |
| `prisma/schema.prisma` | `passwordHash` 改为可空 |

---

## 二、PrismaService 为什么要包一层

不是多此一举，它解决三个具体问题：

1. **单例**：`PrismaClient` 内部维护连接池，每次 `new` 都会新建一个池。包成 `@Injectable()` 后，Nest 保证全局只有一个实例。
2. **生命周期**：实现 `OnModuleInit` / `OnModuleDestroy`，在启动时 `$connect()`、关闭时 `$disconnect()`。好处是**连不上数据库会在启动阶段就报错**，而不是等第一个请求才 500。
3. **可替换**：业务代码注入的是 `PrismaService`，将来换 ORM 只改这一层。

配套的 `@Global()` 让业务模块不必逐个 `imports`，与 `ConfigModule.forRoot({ isGlobal: true })` 是同一思路。

---

## 三、三个值得记住的设计

### 3.1 `select` 白名单，而不是「查全部再删」

```ts
const USER_SELECT = {
  id: true, email: true, name: true, role: true, createdAt: true,
} satisfies Prisma.UserSelect;
```

`satisfies` 让字段名写错时立刻编译报错，同时不丢失字面量类型。
用白名单的根本原因是**安全**：`passwordHash` 根本不会被查询出来，也就不存在「忘了删字段」的泄露风险。

### 3.2 `$transaction` 保证 total 与 items 一致

```ts
const [total, rows] = await this.prisma.$transaction([
  this.prisma.user.count({ where }),
  this.prisma.user.findMany({ where, skip, take }),
]);
```

如果不放在事务里，两次查询之间可能插入新用户，出现 **total=11 但当前页只有 10 条且总数对不上** 的诡异现象。

### 3.3 唯一约束冲突：捕获 P2002，而不是「先查再插」

```ts
if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
  throw new ConflictException(`邮箱 ${dto.email} 已存在`);
}
```

「先 `findUnique` 判断不存在再 `create`」在并发下有窗口期：两个请求同时通过检查，其中一个必然撞库。
**把判断交给数据库的唯一索引，把异常翻译成 HTTP 语义**，才是正确姿势。

---

## 四、类型映射：数据库类型 ≠ API 类型

| 数据库（Prisma） | API（第 1 周契约） | 为什么转 |
|---|---|---|
| `createdAt: Date` | `createdAt: string`（ISO） | JSON 里没有 Date，且前端已按字符串处理 |
| `role: 'ADMIN' \| 'MEMBER'` | `'admin' \| 'member'` | 保持前端既有契约，避免联动改动 |
| `passwordHash: string?` | **不返回** | 敏感字段永不出网 |

映射集中在 `toUser()` 一个函数里。这条边界很关键：**数据库变了，对外契约不能跟着变**，否则前端要陪着你一起改。

---

## 五、分页：从数组切片到 SQL 分页

第 1 周：`filtered.slice((page-1)*size, page*size)` —— 把**所有**用户读进内存再切。
第 2 周：`skip` + `take` 直接下推到数据库的 `OFFSET` / `LIMIT`，配合 `count()` 计算 total。

数据量到 10 万时，这两种写法是「几十毫秒」和「几百毫秒 + 内存暴涨」的区别。

> 进阶提示：深分页（`page=10000`）时 `OFFSET` 仍会扫描并丢弃前面的行。
> 生产上常用**游标分页**（`where: { createdAt: { lt: lastCreatedAt } }`），本项目暂不涉及。

---

## 六、实测结果

| # | 场景 | 结果 |
|---|---|---|
| 1 | `POST /api/users` 创建 Alice | **201**，id 为 cuid（`cmwj9ig2u0000y3mg2bodpfyk`） |
| 2 | 重复邮箱再创建 | **409** `邮箱 alice@example.com 已存在` |
| 3 | `GET /api/users?page=1&pageSize=5` | **200**，`total=1, totalPages=1` |
| 4 | `GET /api/users/nope` | **404** |
| 5 | 服务器直接查库 | `alice@example.com \| ADMIN` —— 确实落库 |

第 5 条是本日最关键的验证：**数据不在内存里，而在 PostgreSQL 中**。

---

## 七、踩坑记录

1. **`PaginationQuery` 的字段是可选的**（`page?: number`），直接用会报 `Type 'number | undefined' is not assignable`。需给默认值再用。
2. **Prisma 默认列名是 camelCase**：`select "createdAt"` 要加双引号，否则 PostgreSQL 会当作小写 `createdat` 而报「列不存在」。
3. **SSH 隧道会静默断开**：连续操作几分钟后 `Connection reset`，Prisma 报 `P1001`。重开隧道即可，参数见 `infra/deploy/pg-tunnel.ps1`。

---

## 八、自测题

1. 为什么 `PrismaService` 要包一层并实现 `onModuleInit`，而不是在 Service 里直接 `new PrismaClient()`？
2. 为什么分页要 `count` 和 `findMany` 放进同一个 `$transaction`？不放进会怎样？
3. `select` 白名单和「查出来再 `delete user.passwordHash`」相比，安全性差别在哪？

---

## 九、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
