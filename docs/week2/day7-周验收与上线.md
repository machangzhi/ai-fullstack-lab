# 第 2 周 Day 7 笔记：周验收与上线

> 目标：把"本地能跑"变成"公网能跑"，并且用验收清单代替"我觉得应该没问题"。

---

## 一、本周交付物

| 层 | 内容 |
|---|---|
| 数据库 | PostgreSQL 14（服务器本机，仅监听 127.0.0.1），3 张表 + 3 次迁移 |
| 后端 | Prisma 接入、argon2 注册登录、双 Token + 轮换、RBAC、登录限流、错误码规范化 |
| 前端 | 登录/注册页、用户列表页、Pinia、axios 自动续期、路由守卫 |
| 部署 | `deploy.py` 增加 Prisma 生成与迁移步骤，服务器 `.env` 注入数据库与 JWT 配置 |

---

## 二、部署链路的变化

第 1 周只传 `dist`，第 2 周多了三件事：

```
上传 dist + prisma/（schema + migrations）
   ↓
npm install（含 prisma CLI）
   ↓
npx prisma generate      ← 生成与 schema 匹配的 Client
   ↓
npx prisma migrate deploy ← 在服务器库上重放迁移（只执行已有文件）
   ↓
npm prune --omit=dev     ← 裁掉开发依赖，减小体积
   ↓
systemctl restart lab-api
```

两个关键点：

1. **生产只跑 `migrate deploy`**，绝不跑 `migrate dev`——后者可能生成新迁移并重置数据。
2. **`generate` 必须在服务器执行**：Prisma Client 包含平台相关的查询引擎二进制，本地 Windows 生成的不能直接用于 Linux。

服务器 `.env` 新增：

```
DATABASE_URL=postgresql://ai_lab:***@127.0.0.1:5432/ai_lab?schema=public
JWT_SECRET=...
JWT_REFRESH_SECRET=...
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
LOGIN_MAX_ATTEMPTS=5
LOGIN_WINDOW_MS=900000
```

---

## 三、验收清单（11 项，全部通过）

| # | 场景 | 预期 | 实测 |
|---|---|---|---|
| 1 | `GET /lab/api/health` | 200 | ✅ |
| 2 | 注册（公网） | 201，role=member | ✅ `expiresIn=900` |
| 3 | 登录 | 200 + accessToken | ✅ |
| 4 | `/auth/me` | 200 | ✅ 返回邮箱 |
| 5 | `/users` 无 Token | 401 | ✅ `UNAUTHORIZED` |
| 6 | `/users` 普通用户 | 403 | ✅ `FORBIDDEN` |
| 7 | `/users` 管理员 | 200 | ✅ `total=7` |
| 8 | refresh 换新 | 200 且新令牌不同 | ✅ |
| 9 | **重放旧 refresh** | 401 | ✅ `UNAUTHORIZED` |
| 10 | `/lab/docs` | 200 | ✅ |
| 11 | `/lab/login` 页面 | 200 | ✅ |

---

## 四、上线后发现的真 bug：同一秒签发的 JWT 完全相同

### 现象

生产验收时，"重放旧 refresh token"本应 401，却返回 **200**，且新令牌与旧令牌**字符串完全相同**。

### 原因

JWT 的 `iat` / `exp` 精度只到**秒**。在同一秒内用相同 payload 签发：

```
payload = { sub, role, type: 'refresh', iat: 1794835380, exp: 1795440180 }
```

签名结果**逐字节相同**。于是"轮换"变成：刷新 → 存新哈希（其实和旧哈希一样）→ 旧令牌继续有效。

### 修复

给每个令牌加 `jti`（JWT ID，随机 UUID）：

```ts
{ ...base, type: 'refresh', jti: randomUUID() }
```

### 验证

```
first refresh: 200 differs: true
reuse r1: 401 UNAUTHORIZED
use r2: 200 ok
```

### 为什么本地测不出来

本地测试里登录与刷新之间隔了几秒，`iat` 不同，令牌天然不同。**只有把流程压缩到同一秒、且真的打到生产环境，才会暴露。** 这是"集成环境验收"不可替代的典型例子。

---

## 五、本周踩坑汇总

| # | 坑 | 教训 |
|---|---|---|
| 1 | Prisma 安装到 8.0-rc 预发布版 | CLI 与 Client 版本必须一致，显式锁版本 |
| 2 | `migrate dev` 需要影子库权限 | 生产用 `migrate deploy`，不给 CREATEDB |
| 3 | `Nest can't resolve dependencies of the JwtAuthGuard` | 守卫在使用方模块实例化，AuthModule 要 exports JwtModule |
| 4 | `HttpException('字符串')` 的错误码漏映射 | 过滤器有多个分支，要逐一覆盖 |
| 5 | PowerShell `"Bearer $obj.token"` | 插值要写 `$($obj.token)`；复杂测试脚本改用 Node |
| 6 | `.vue` 顶层不能放 `/** */` | 注释写进 `<script setup>` |
| 7 | **同秒 JWT 完全相同** | payload 必须有 `jti` 之类的唯一字段 |
| 8 | SSH 隧道静默断开 | 加 `ServerAliveInterval`，或用 `pg-tunnel.ps1` |

---

## 六、技术债（Week 3 处理）

| 项 | 影响的场景 |
|---|---|
| 限流状态在内存 | 多实例部署失效 → 需 Redis |
| refresh token 存 localStorage | XSS 风险 → 改 HttpOnly Cookie |
| access token 无法立即作废 | 封号后仍有 15 分钟窗口 → 黑名单/版本号 |
| 无审计表 | 只有 stdout 日志 → 落库便于查询 |
| 无自动化测试 | 回归靠手点 → 第 3 周补 Jest + supertest |
| 前端无 UI 库 | 手写样式效率低 → 接 Element Plus |

---

## 七、Week 3 预告

- 对话模型接入：流式输出（SSE）、Token 计数、超时与重试
- conversations / messages 两张表真正用起来
- 前端聊天界面 + 打字机效果
- 引入测试：Service 单测 + 接口 e2e

---

## 八、自测题

1. 为什么 `prisma generate` 必须在服务器上执行，而不能本地生成后把 `node_modules` 一起上传？
2. 生产为什么只能用 `migrate deploy` 而不能用 `migrate dev`？
3. 如果没加 `jti`，refresh 轮换失效会带来什么实际安全风险？（提示：想想"旧令牌还能用"意味着什么）

---

## 九、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
