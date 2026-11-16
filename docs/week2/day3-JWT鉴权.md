# 第 2 周 Day 3 笔记：JWT 鉴权（注册 / 登录 / 当前用户）

> 目标：建立完整身份链 —— 注册哈希密码 → 登录签发 Token → 请求校验 Token → 获取当前用户。

---

## 一、为什么密码要用 argon2id

| 方案 | 速度 | 能否用于密码 |
|---|---|---|
| MD5 / SHA256 | 每秒数十亿次 | ❌ 显卡几秒爆破常见弱密码 |
| SHA256 + 随机盐 | 仍很快 | ❌ 只是防彩虹表，不防暴力 |
| bcrypt | 可调 cost | ✅ 但内存开销小，GPU 仍占优 |
| **argon2id** | 同时消耗 CPU + 内存 | ✅ 当前推荐 |

关键认知：

1. **哈希 ≠ 加密**。不可逆，所以「找回密码」只能重置，不能把原密码给你。
2. **盐由算法自动生成并写进哈希串**，不需要自己存字段。
3. **恒定时间比较**：`argon2.verify` 内部不会在第一位不匹配时就返回，避免通过响应时间逐位猜测。
4. 参数（本项目）：`memoryCost=19456`（19 MiB）、`timeCost=2`、`parallelism=1`，取自 OWASP 建议下限。

---

## 二、JWT 的结构与红线

```
header.payload.signature
```

| 段 | 内容 | 是否机密 |
|---|---|---|
| header | `{"alg":"HS256","typ":"JWT"}` | ❌ base64 明文 |
| payload | `{"sub":"cmwj...","role":"MEMBER","iat":...,"exp":...}` | ❌ **明文** |
| signature | HMAC(header+payload, JWT_SECRET) | — |

**JWT 防篡改，不防窥探。** 实测把 payload 段 base64 解码：

```json
{"sub":"cmwj9pfan0000y36owojulcqk","role":"MEMBER","iat":1794833805,"exp":1795438605}
```

所以 payload 只放：用户 ID（`sub`）、角色（`role`）、时间戳。
**绝不放**：密码、手机号、身份证、验证码、任何你不想公开展示的内容。

---

## 三、请求链：Guard 在哪一步

```
Middleware → Guard → Interceptor(前) → Pipe → Controller
```

Guard 在 Pipe **之前**：未登录请求连 DTO 校验都不做，直接 401。
这不是巧合，而是「先认证、再校验」的物理保证。

---

## 四、本日实现

| 文件 | 作用 |
|---|---|
| `auth/dto/register.dto.ts` | 邮箱格式、昵称长度、密码强度（≥8 位且含字母数字） |
| `auth/dto/login.dto.ts` | 只校验非空——登录不校验强度，否则老用户无法登录 |
| `auth/types/jwt-payload.ts` | payload 类型（sub + role） |
| `auth/guards/jwt-auth.guard.ts` | 取 Bearer → verify → 挂 `req.user` |
| `auth/decorators/current-user.decorator.ts` | `@CurrentUser()` 取 payload |
| `auth/auth.service.ts` | 注册 / 登录 / findMe |
| `auth/auth.controller.ts` | `POST /register`、`POST /login`、`GET /me` |
| `auth/auth.module.ts` | `JwtModule.registerAsync`，密钥缺失即启动失败 |

### 三个设计决策

1. **不用 passport-jwt**：本项目只需「取头 → 验签 → 挂用户」，自己写 20 行比引入策略体系更透明。
2. **登录失败统一 401 + 同一句文案**：`邮箱或密码错误`。区分「用户不存在」会让人批量枚举注册用户。
3. **`findMe` 回库查**：Token 里的 `role` 可能已过期，用户也可能已被删除。**身份以数据库为准**。

### 时序攻击的处理

用户不存在时，也用一个固定的「假哈希」跑一次 `argon2.verify`：

```ts
this.dummyHash ??= argon2.hash('timing-equalizer', ARGON2_OPTIONS);
const hashToCheck = row?.passwordHash ?? (await this.dummyHash);
const ok = await argon2.verify(hashToCheck, dto.password).catch(() => false);
```

否则「账号不存在」会立即返回，而「密码错误」要消耗 50ms 哈希时间，攻击者据此就能判断账号是否存在。

---

## 五、实测结果（10 项）

| # | 场景 | 预期 | 实测 |
|---|---|---|---|
| 1 | 注册 bob | 201 + Token | ✅ 201，token 长 195 |
| 2 | 重复注册 | 409 | ✅ `该邮箱已被注册` |
| 3 | 弱密码 `12345678` | 400 | ✅ `密码必须同时包含字母和数字` |
| 4 | 密码错误 | 401 | ✅ `邮箱或密码错误` |
| 5 | 账号不存在 | 401 | ✅ `邮箱或密码错误`（与 4 完全一致） |
| 6 | 正确登录 | 200 | ✅ |
| 7 | `/me` 无 Token | 401 | ✅ `缺少访问令牌` |
| 8 | `/me` 带 Token | 200 | ✅ 返回 bob 的完整信息 |
| 9 | 篡改签名 | 401 | ✅ `访问令牌无效或已过期` |
| 10 | 解码 payload | 无敏感字段 | ✅ 只有 sub/role/iat/exp |

---

## 六、踩坑记录

1. **argon2 的类型名是 `HashOptions` 不是 `Options`**；写错会让 `hash()` 落到返回 `Buffer` 的重载上，报 `Buffer is not assignable to string`。
2. **`expiresIn` 的类型是模板字面量**（jsonwebtoken v9 的 `StringValue`），从 `ConfigService` 读出来是普通 `string`，需要显式收窄。
3. **PowerShell 5.1 读 UTF-8 无 BOM 脚本会乱码**：用 Write 工具生成的含中文 `.ps1` 会解析失败（引号错位）。测试脚本请全英文，或另存为带 BOM 的 UTF-8。

---

## 七、还没做的（技术债）

| 项 | 计划 |
|---|---|
| Refresh Token | Day 4：短期 access(15m) + 长期 refresh(7d)，支持吊销 |
| 角色守卫（RBAC） | Day 4：`@Roles('admin')` 限制管理接口 |
| 登录限流 | Day 5：同一 IP/邮箱失败 5 次锁定，防暴力破解 |
| Token 黑名单 | 引入 Redis 后再做（当前登出仅前端删 Token） |

---

## 八、自测题

1. 为什么 JWT payload 里不能放手机号？攻击者需要密钥才能看到吗？
2. 「用户不存在」和「密码错误」返回不同错误码，会带来什么具体攻击？
3. `/auth/me` 为什么要回数据库查一次，而不是直接用 Token 里的 `sub` 和 `role` 拼出响应？

---

## 九、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
