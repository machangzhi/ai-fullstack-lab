# 第 2 周 Day 4 笔记：Refresh Token 与 RBAC

> 目标：把"一次登录、长期有效"改成"短期访问 + 可撤销刷新"，并给接口加上角色限制。

---

## 一、双令牌：为什么必须拆成两个

| | Access Token | Refresh Token |
|---|---|---|
| 有效期 | 15 分钟 | 7 天 |
| 携带频率 | 每个请求 | 只在刷新时 |
| 服务端是否存储 | 否（无状态） | 是（只存哈希） |
| 能否撤销 | ❌ 不能 | ✅ 覆盖哈希即失效 |
| 泄露后的损失 | 15 分钟 | 一次刷新，且能被重放检测 |

核心矛盾：**JWT 无状态 → 无法撤销 → 但它必须长期有效才方便**。
拆分后：短的那个泄露损失小，长的那个由服务端控制生死。

---

## 二、Refresh Token 的四个安全要求

| # | 要求 | 本项目的实现 |
|---|---|---|
| 1 | 只存哈希 | `refreshTokenHash = sha256(token)` |
| 2 | 轮换 | 每次刷新覆盖哈希，旧 token 立即失效 |
| 3 | 独立密钥 | `JWT_SECRET`（access）vs `JWT_REFRESH_SECRET` |
| 4 | 类型校验 | payload `type: 'access' \| 'refresh'` |

### 为什么用 SHA-256 而不是 argon2

refresh token 是**服务端生成的 256 位高熵串**，不存在"弱口令"问题，慢哈希只会拖慢刷新接口。
argon2 是给"人选的密码"用的；机器生成的随机串用快哈希足够，而且能防"撞库式"滥用的成本很低。

### 类型校验为什么不能省

没有 `type`，攻击者可以把 15 分钟的 access token 直接发到 `/auth/refresh`，换来 7 天的 refresh —— 短令牌的"短"就失去意义了。实测第 5 项就是验证这一点。

### 恒定时间比较

```ts
timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(sha256(token), 'utf8'))
```

普通 `===` 会在第一个不同字符处返回，理论上能被时间差逐字符猜出哈希。高熵串虽然难猜，但**这个习惯要养成**。

---

## 三、RBAC：元数据 + 守卫

```ts
@Get()
@UseGuards(JwtAuthGuard, RolesGuard)   // 顺序：先认证，再鉴权
@Roles('ADMIN')
```

| 组件 | 职责 |
|---|---|
| `@Roles()` | `SetMetadata` 声明要求，本身不校验 |
| `RolesGuard` | `Reflector` 读回元数据，比对 `req.user.role` |
| 顺序 | 必须 JWT 在前，否则 `req.user` 还不存在 |

**403 vs 401 的语义**：
- 401 = 你没登录（或凭证无效）→ "先登录"
- 403 = 你登录了，但没权限 → "别试了"

### 踩坑：`Nest can't resolve dependencies of the JwtAuthGuard`

守卫在 `@UseGuards()` 里被使用时，Nest 会在**使用方模块**（UsersModule）的上下文实例化它。
UsersModule 只 `imports: [AuthModule]` 还不够——必须让 AuthModule **导出 JwtModule**，否则 `JwtService` 不可见。

```ts
exports: [JwtModule, AuthService, JwtAuthGuard, RolesGuard]
```

---

## 四、实测结果（8 项）

| # | 场景 | 预期 | 实测 |
|---|---|---|---|
| 1 | 登录（carol 已提升为 ADMIN） | 200，role=admin | ✅ |
| 2 | 管理员访问 `GET /users` | 200 | ✅ total=3 |
| 3 | 用 refresh 换新令牌 | 200，新 access | ✅ |
| 4 | **重放旧的 refresh** | 401 | ✅ `刷新令牌已失效，请重新登录` |
| 5 | **用 access 调刷新接口** | 401 | ✅ `刷新令牌无效或已过期` |
| 6 | 登出 | 204 | ✅ |
| 7 | **登出后再刷新** | 401 | ✅ 同上 |
| 8 | 新 access 访问 `/auth/me` | 200 | ✅ carol@example.com |

另：
| 场景 | 结果 |
|---|---|
| member 访问管理接口 | **403** `无访问权限` |
| 无 Token 访问 `/users` | **401** |
| 注册返回 `expiresIn` | **900**（15 分钟） |

---

## 五、踩坑记录

1. **`Nest can't resolve dependencies of the JwtAuthGuard (?). JwtService`**
   原因：AuthModule 没有导出 JwtModule。守卫在使用方模块实例化，必须能拿到 JwtService。
2. **PowerShell 字符串插值陷阱**：`"Bearer $obj.token"` 只展开 `$obj`，后面当成字面量。
   正确写法 `"Bearer $($obj.token)"`。这个坑会让请求头变成非法值，表现为莫名其妙的 401。
3. **改角色后必须重新登录**：`role` 在签发时写进 payload，改库不会影响已发出的 Token。
   这也是为什么 `/auth/me` 要回库查——Token 里的角色是快照。

---

## 六、仍未解决的（留给 Day 5）

| 项 | 方案 |
|---|---|
| access token 无法立即作废 | 短期 + 黑名单（Redis）或用户版本号 |
| refresh token 存请求体有 XSS 风险 | 改 HttpOnly Cookie + SameSite |
| 无登录限流 | 同 IP/邮箱连续失败锁定 |
| 无审计日志 | 登录/刷新/登出记录到表 |

---

## 七、自测题

1. 为什么要给 access 和 refresh 用**不同**的密钥？共用一个会怎样？
2. 轮换（rotation）能防住什么攻击？如果攻击者先用了旧 refresh，真正的用户会遇到什么？
3. `RolesGuard` 里返回 403 而不是 401，对前端处理有什么不同？

---

## 八、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
