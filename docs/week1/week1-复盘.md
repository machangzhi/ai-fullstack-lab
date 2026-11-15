# 第 1 周复盘：工程基础与前后端骨架

> 周期：2026-11-11 ~ 2026-11-15
> 分支：`week1` → `master`
> 目标：跑通"前端 → 后端 → 统一响应 → 部署上线"的最小闭环

---

## 一、本周交付物（事实清单）

| 类别 | 内容 | 证据 |
| --- | --- | --- |
| 工程骨架 | pnpm workspace monorepo（apps / packages / mcp-servers） | `pnpm-workspace.yaml` |
| 后端 | NestJS + Config + 全局管道/拦截器/过滤器 + Swagger | `apps/api` |
| 前端 | Vue 3 + Vite + Vue Router + 统一请求封装 | `apps/web` |
| 接口 | `/api/health`、`/api/config`、`/api/users`（列表/详情/创建） | Swagger `/docs` |
| 规范 | 统一响应结构、错误码骨架、requestId 链路 | `common/` |
| 部署 | Nginx 子路径 `/lab/`、systemd 服务、公网可访问 | `infra/deploy/deploy.py` |
| 文档 | Day1~Day6 六篇学习笔记 + README | `docs/week1/` |
| 版本管理 | 每周分支工作流 + Conventional Commits | `git log` |

---

## 二、验收清单（逐项打勾）

| # | 检查项 | 期望 | 状态 |
| --- | --- | --- | --- |
| 1 | `pnpm dev` 能同时起前后端 | 9527 + 5173 | ☐ |
| 2 | `pnpm -r build` 全仓通过 | 无 TS 报错 | ☐ |
| 3 | `GET /api/health` | `success:true` + uptime | ☐ |
| 4 | `GET /api/users?page=1&pageSize=10` | 分页结构正确 | ☐ |
| 5 | `POST /api/users` 中文姓名 | 200，中文不乱码 | ☐ |
| 6 | 非法 email | 400 + `details` 数组 | ☐ |
| 7 | 不存在的用户 | 404 + 明确 code | ☐ |
| 8 | 响应头含 `x-request-id` | 有值 | ☐ |
| 9 | `/docs` 可访问且 Try it out 可用 | 200 | ☐ |
| 10 | 公网 `http://118.89.166.194/lab/` | 页面 + 接口正常 | ☐ |

---

## 三、踩坑记录（比笔记更值钱）

| 坑 | 现象 | 根因 | 解决 |
| --- | --- | --- | --- |
| 端口占用 | `EADDRINUSE 9527` | `node --watch` 反复重启 + 手动启动抢占 | 定位 PID 后 `Stop-Process`，统一用 `pnpm dev` |
| Swagger 链接失效 | 线上点"API 文档"跳 localhost | 前端硬编码 `http://localhost:9527/docs` | 改用 `import.meta.env.BASE_URL + 'docs'` |
| 子路径 404 | `/lab/docs` 打不开 | Vite `base` 硬编码 `/lab/` | 按 `command === 'serve'` 区分 dev/prod |
| Swagger 请求错地址 | Try it out 打到站点根 | 未配置 `servers` | `SWAGGER_SERVER_URL=/lab` + `addServer()` |
| 推送失败 | `Failed to connect github.com:443` | 本地代理未启动 | `git config http.proxy` + 开启 Clash |
| 中文乱码 | POST 后 name 变 `????` | PowerShell 默认编码 | `-ContentType "application/json; charset=utf-8"` |
| 元数据失效实验 | 服务能启动，请求 500 | `emitDecoratorMetadata: false` | 恢复 `true`，理解 DI 依赖该元数据 |

---

## 四、五个必须内化的知识点

1. **`emitDecoratorMetadata` 是 Nest DI 的命根子**：关掉不报编译错，但注入参数变 `undefined`，且 `ValidationPipe` 静默失效。
2. **路径别名必须双配置**：`tsconfig.paths` 管类型检查，`vite.alias` 管模块解析，缺一出不同症状。
3. **`VITE_` 变量会被打进前端产物**：已做实验证实（构建后在 JS 里能直接搜到）。密钥只能放后端。
4. **模块是可见性边界**：`providers` 决定本模块能否注入，`exports` 决定别人能否注入。
5. **Service 默认单例**：不能存请求级状态，否则并发串号。

---

## 五、技术债（Week 2 处理）

| 债务 | 现状 | 计划 |
| --- | --- | --- |
| 错误码不规范 | `code` 取自 `'Bad Request'` 等英文句子 | 统一 `AppError` + `{资源}_{问题}` 规范 |
| 无测试 | 0 个测试文件 | 接入 Jest，先覆盖 `paginate` 与 `/health` |
| 数据不持久化 | 内存数组 | PostgreSQL + Prisma |
| 无鉴权 | 任何人可调接口 | JWT + Guard + RBAC |
| 日志未落盘 | 仅 stdout | 结构化日志 + 文件/集中采集 |
| 前端无状态管理 | 单页 demo | Pinia + 登录态 + Axios 拦截器 |

---

## 六、Week 2 目标（PostgreSQL + 鉴权）

1. `docker` 起 PostgreSQL，Prisma 建模 `users / conversations / messages`，迁移脚本入库。
2. 注册/登录/刷新 Token，密码 `bcrypt` 哈希，JWT 双 token 策略。
3. `JwtAuthGuard` + `@Roles()` 装饰器，实现 RBAC。
4. 前端登录页 + Pinia 存 token + Axios 请求/响应拦截器（401 自动刷新）。
5. 把内存数组的 `UsersService` 换成 Prisma 实现，接口签名不变。
6. 文件上传模块（头像），限制类型与大小。

---

## 七、自评（自己填）

| 维度 | 1~5 分 | 依据 |
| --- | --- | --- |
| 能否独立解释 monorepo 的依赖与脚本 | | |
| 能否解释一次请求经过的 7 个阶段 | | |
| 能否不看笔记说出 DI 的原理与坑 | | |
| 能否独立定位一个 500 错误 | | |
| 能否规范地提交并合并一周代码 | | |

## 八、三个反思问题

1. 这周哪个报错花的时间最久？下次遇到同类问题，第一步该做什么？
2. 哪些知识点是"能背出来但没验证过"的？（把它们列出来，下周做实验验证）
3. 如果只能保留三条笔记，你留哪三条？为什么？

## 九、下周开始前的检查

- [ ] 所有服务已停止（9527 / 5173 无监听）
- [ ] `git status` 干净，`week1` 已合并到 `master` 并推送
- [ ] 笔记全部提交
- [ ] 环境变量文件 `.env` 未被提交
- [ ] 服务器上 `/lab/` 仍可访问（部署未破坏）
