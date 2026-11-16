# 第 2 周 Day 1 笔记：数据库选型与 Prisma 心智模型

> 本日目标：搞清「为什么换数据库」「为什么用 PostgreSQL」「ORM 的边界在哪」，并把 Prisma 接进 `apps/api`。

---

## 一、为什么必须离开内存存储

第 1 周的 `UsersService` 用一个 `Map` 存用户，它的问题不是「简陋」，而是四个硬伤：

| 问题 | 表现 | 后果 |
|---|---|---|
| 重启丢失 | `node --watch` 热重载，数据全没 | 开发时反复造数据，无法复现问题 |
| 多实例不一致 | 第二个进程有自己的 Map | 负载均衡后「刚创建的用户查不到」 |
| 无法查询 | 只能 `filter` 全量数组 | 数据量一大就全表扫描 |
| 无事务 | 两次写操作之间失败 | 数据半成品（扣了库存没生成订单） |

第 4 条最容易被低估：**事务不是高级功能，而是「多步写入」的基本正确性保证**。
本周要做的「创建会话 + 插入第一条消息」，必须同一个事务里完成，否则会出现「有会话没消息」的脏数据。

---

## 二、四种数据库的取舍

| | PostgreSQL | MySQL | SQLite | MongoDB |
|---|---|---|---|---|
| 类型 | 关系型 | 关系型 | 嵌入式关系型 | 文档型 |
| 强项 | 标准 SQL、JSONB、扩展生态 | 生态成熟、运维资料多 | 零部署、单文件 | Schema 灵活 |
| 弱项 | 运维略重 | JSON 支持较弱 | 单写入、无并发 | 无 JOIN、跨文档事务弱 |
| 本项目相关 | **pgvector 向量检索** | 需外部方案 | 不支持向量 | 需 Atlas 云服务 |

### 为什么选 PostgreSQL

1. **JSONB**：模型响应、工具调用参数、metadata 都是半结构化数据。JSONB 既能当 JSON 存，又能建 GIN 索引查询，比「再开一张表」灵活。
2. **pgvector**：第 6 周做 RAG 时，`embedding vector(1536)` + 余弦距离一个扩展搞定，不用再引入专业向量数据库。
3. **约束表达力更强**：`CHECK` 约束、部分唯一索引、`ON CONFLICT ... DO UPDATE` 都比 MySQL 好用。

### 为什么不与服务器上已有的 MySQL（笔记模块）共用

**故障域隔离**。两个项目生命周期不同、迁移节奏不同、权限模型不同。
共用一个实例，一次误操作（比如把 `notes_db` 的权限改错）可能同时弄挂两个服务。
共用实例可以，但**至少要用不同的 database 和不同的账号**。

---

## 三、ORM 解决什么、不解决什么

> ORM 不是「不用学 SQL」，而是「消除重复的 CRUD 模板代码」。

| ORM 解决的 | ORM 不解决的 |
|---|---|
| 类型安全（字段改名编译期报错） | N+1 查询 |
| SQL 注入（自动参数化） | 慢查询定位 |
| 关系导航（`user.conversations`） | 复杂聚合、窗口函数 |
| 迁移版本化 | 索引设计是否合理 |

判断标准：**单表 CRUD 用 ORM，复杂分析写 SQL**。
所以 Prisma 提供 `$queryRaw` —— 不必为了「纯 ORM」写出丑陋的嵌套查询。

---

## 四、Prisma 的四个概念

```
schema.prisma ──generate──▶ Prisma Client（类型安全的查询 API）
      │
      └──migrate──▶ migrations/*.sql ──apply──▶ 数据库表结构
```

| 命令 | 作用 | 类比 |
|---|---|---|
| `prisma generate` | 根据 schema 生成类型化 Client | `tsc` |
| `prisma migrate dev` | 对比 schema 与库，生成并执行 SQL（开发用） | `git commit` |
| `prisma migrate deploy` | 只执行已有迁移文件，不生成新的（生产用） | `git pull && 应用补丁` |
| `prisma db push` | 直接把 schema 同步到库，**不留迁移文件** | 临时草稿 |
| `prisma studio` | 网页版数据浏览器 | phpMyAdmin |

**核心心智**：schema 是声明式的「唯一真相」，迁移是它的产物。数据库结构随代码一起进入 Git。

`migrate dev` vs `db push` 的区别，是本日必答题（见文末）。

---

## 五、三张表的设计

```
users ──1:N──▶ conversations ──1:N──▶ messages
```

| 表 | 关键字段 | 设计理由 |
|---|---|---|
| `users` | `email` 唯一、`passwordHash` | 邮箱做登录标识；只存哈希，永不存明文 |
| `conversations` | `userId`、`updatedAt` | 索引 `(userId, updatedAt)` 支撑「我的会话列表」 |
| `messages` | `conversationId`、`role`、`content`、`tokens` | 索引 `(conversationId, createdAt)` 支撑「拉取消息」 |

三个现在就定下来的习惯：

1. **主键用 `cuid()`**：不泄露业务量（自增 ID 会让用户看出你只有 1024 人）、分布式生成不冲突。
2. **时间戳成对出现**：`createdAt` + `updatedAt`，线上排查全靠它们。
3. **外键必须显式写 `onDelete`**：删用户时会话跟着删（Cascade）还是禁止删（Restrict）？你不决定，数据库就替你决定。

---

## 六、今日实操记录（环境搭建）

### 6.1 本机现状

| 检查 | 结果 |
|---|---|
| Docker | ❌ 未安装 |
| 本地 PostgreSQL | ❌ 未安装 |
| WSL | ⚠️ 有 `wsl.exe` 但无发行版 |
| 管理员权限 | ❌ 无（装 Docker / PG 会弹 UAC） |

原计划「方案 A：Docker 起库」不可行，改用**方案 C：服务器 PostgreSQL + SSH 隧道**。

### 6.2 服务器侧

```bash
# 安装（Ubuntu 24.04，装到 PG 14.24）
sudo apt-get install -y postgresql

# 建角色与库
sudo -u postgres psql -c "CREATE ROLE ai_lab LOGIN PASSWORD '<password>';"
sudo -u postgres createdb -O ai_lab ai_lab
# migrate dev 需要影子库，因此要 CREATEDB 权限
sudo -u postgres psql -c "ALTER ROLE ai_lab CREATEDB;"

# 确认只监听本机
ss -lntp | grep 5432
# → 127.0.0.1:5432  （不是 0.0.0.0:5432，公网不可达）
```

**安全线**：数据库只监听 `127.0.0.1`，不开放 5432 到公网。访问必须经 SSH 隧道。

### 6.3 本地隧道

```bash
ssh -N -L 55432:127.0.0.1:5432 ubuntu@118.89.166.194 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3
```

- 本地 `55432` → 服务器 `127.0.0.1:5432`
- 为什么不用 5432：避免与将来本地安装的 PG 冲突
- 为什么不加保活会断：服务器会清理闲置 SSH 连接（实测几十秒后 `Connection reset`）

仓库内已封装为 [pg-tunnel.ps1](../../infra/deploy/pg-tunnel.ps1)。

### 6.4 Prisma 接入

```bash
pnpm --filter @ai-lab/api add @prisma/client@6.16.2
pnpm --filter @ai-lab/api add -D prisma@6.16.2
```

**踩坑记录**：默认安装会把 `prisma` 解析到 `8.0.0-rc.33` 预发布版，与 `@prisma/client` 7.x 不匹配。**CLI 与 Client 版本必须一致**，因此显式锁定 `6.16.2`。

```bash
pnpm --filter @ai-lab/api exec prisma migrate dev --name init
```

结果：

```
prisma\migrations/
  └─ 20261116124031_init/
    └─ migration.sql
✔ Generated Prisma Client (v6.16.2)
```

服务器验证：

```
 public | _prisma_migrations | table
 public | conversations      | table
 public | messages           | table
 public | users              | table
```

### 6.5 新增的 npm 脚本

| 命令 | 等价于 |
|---|---|
| `pnpm --filter @ai-lab/api db:migrate` | `prisma migrate dev` |
| `pnpm --filter @ai-lab/api db:deploy` | `prisma migrate deploy` |
| `pnpm --filter @ai-lab/api db:generate` | `prisma generate` |
| `pnpm --filter @ai-lab/api db:studio` | `prisma studio` |

---

## 七、自测题

1. 为什么主键不用自增整数，而用 `cuid()` / `uuid()`？（说出两条理由）
2. `prisma migrate dev` 和 `prisma db push` 的区别是什么？生产环境该用哪个？
3. 如果把 `messages.content` 改成 `Json` 类型（存多模态数组），好处和代价各是什么？

---

## 八、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
