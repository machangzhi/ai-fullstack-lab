# Week 4 Day 6：阶段验收 — AI Chat v1.0

> 目标：复盘第 3～4 周的模型接入、结构化输出、工具调用与评估方法，发布 AI Chat v1.0，并交付架构图、API 文档、测试报告与演示材料。
>
> 版本：1.0.0　验收日期：2026-11-21　分支：`week4`

## 一、验收结论

| 验收项 | 结果 | 说明 |
| --- | --- | --- |
| 模型接入与切换 | 通过 | 两个公开模型档案，客户端只能用别名切换 |
| 多轮上下文 | 通过 | 预算内回放 + 增量摘要，摘要失败降级 |
| SSE 流式输出 | 通过 | 逐字渲染、停止生成、断连取消上游 |
| 结构化输出 | 通过 | Zod 校验，失败带原因重试一次 |
| 工具调用 | 通过 | 白名单、参数校验、最多 4 轮、轨迹记录 |
| 可靠性 | 通过 | 超时、重试、并发限制、熔断与统一错误码 |
| 评估 | 通过 | 20 条固定测试集，4 个版本对比 |
| 架构图 | 通过 | [architecture/ai-chat-v1.md](file:///d:/StudyAI/ai-fullstack-lab/docs/architecture/ai-chat-v1.md) |
| API 文档 | 通过 | [api/ai-chat-v1.md](file:///d:/StudyAI/ai-fullstack-lab/docs/api/ai-chat-v1.md) |
| 自动化测试 | 通过 | ai-core 64/64、API 62/62 |
| 静态检查与构建 | 通过 | lint 0 error、typecheck 通过、web 构建通过 |
| 演示视频 | 待录制 | 脚本已就绪，见第七节 |

结论：**代码、文档与测试达到 AI Chat v1.0 的发布标准；演示视频需要在本地环境按脚本录制。**

## 二、v1.0.0 发布说明

### 2.1 功能范围

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 账号体系 | `/api/auth/*` | 注册、登录、刷新、登出；access 15 分钟、refresh 7 天 |
| 会话与历史 | `/api/conversations/*` | 会话列表、消息分页、归属校验 |
| 单轮对话 | `/api/ai/chat` | 模板可选，返回回复、模型与用量 |
| 单轮流式 | `/api/ai/chat/stream` | SSE `delta` / `meta` / `error` |
| 多轮流式 | `/api/conversations/:id/messages/stream` | 历史回放、摘要记忆、回复落库 |
| 模型切换 | `GET /api/ai/models` | `deepseek-chat` / `deepseek-reasoner` |
| 结构化输出 | `/api/ai/classify`、`/api/ai/extract` | Zod 校验与一次修复重试 |
| 工具调用 | `/api/ai/tools/chat` | 当前时间、计算器、执行轨迹 |
| 用量统计 | `GET /api/ai/usage` | 今日汇总与最近 10 次调用 |
| 文件上传 | `/api/files/upload` | 5MB、MIME 白名单、服务端命名 |
| 可靠性 | 全局模型调用 | 超时、重试、并发、熔断、稳定错误码 |
| 评估 | `pnpm eval:suite` | 20 条固定测试集与版本对比 |

### 2.2 版本变更

- 根包、`@ai-lab/api`、`@ai-lab/web` 版本统一为 `1.0.0`。
- `APP_VERSION` 默认值更新为 `1.0.0`，Swagger 标题与描述更新为 AI Chat v1.0。
- README 更新当前进度、完成第 2～4 周任务项，并补充三份 v1.0 文档入口。
- 首页里程碑调整：第 1～4 周为已完成，第 5～7 周为当前阶段。
- 验收中发现 `GET /users/:id` 与 `POST /users` 缺少鉴权：前者补登录校验，后者限制为 ADMIN；普通用户仍走 `/auth/register` 自助注册。

### 2.3 升级注意事项

- 已有的 `.env` 若仍写着 `APP_VERSION=0.1.0`，健康检查与 `/api/config` 会继续返回旧版本号；需手动改为 `1.0.0`。
- 本次没有数据库结构变更，不需要新迁移。
- `@ai-lab/ai-core` 仍是内部包，版本保持 `0.1.0`，不单独发布。

## 三、测试报告

运行时间：2026-11-21；环境：Windows、Node.js（>=20）、pnpm 9.15.4。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| ai-core 单元测试 | `pnpm --filter @ai-lab/ai-core test` | 64/64 通过（7 个文件） |
| API 单元测试 | `pnpm --filter @ai-lab/api test` | 62/62 通过（8 个文件） |
| 全仓库 lint | `pnpm lint` | 0 error，64 warning（均为前端模板格式） |
| 全仓库类型检查 | `pnpm typecheck` | 3 个包全部通过 |
| Web 生产构建 | `pnpm --filter @ai-lab/web build` | 通过，102 个模块 |

测试覆盖：

| 范围 | 覆盖点 |
| --- | --- |
| ai-core | 模型配置解析、模型档案、Token 估算、上下文规划、摘要消息、Prompt 模板与注入防护、结构化解析、会话消息、评测规则与指标 |
| API | DTO 校验、模型路由、结构化重试、SSE 解析、会话落库、中断处理、摘要降级、工具循环与上限、超时/重试/并发/熔断、错误码映射 |

测试全部使用 Mock 传输层与内存替身，不访问真实模型、不依赖数据库；只有 `eval:suite` 会发起真实计费调用。

### 3.1 评测结果

数据来自 [20 条固定测试集](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/evals/datasets/prompt-suite-20.json)，温度为 0.2，4 个版本共 40 次真实调用：

| 版本 | 准确率 | 成功率 | 失败率 | 平均延迟 | P95 | Tokens |
| --- | --- | --- | --- | --- | --- | --- |
| support-v1 | 100% | 100% | 0% | 1278ms | 1896ms | 4018 |
| support-v2 | 100% | 100% | 0% | 916ms | 1247ms | 4473 |
| classify-v1 | 80% | 100% | 0% | 635ms | 928ms | 2528 |
| classify-v2 | 100% | 100% | 0% | 523ms | 629ms | 4574 |

结论：`classify-v2` 修复了「模糊输入」与「退货优先级」两个错误；客服模板两版都满通过，v2 增加了 250 字约束但 Prompt 更长。详细分析见 [Day 5 文档](file:///d:/StudyAI/ai-fullstack-lab/docs/week4/day5-测试与评估.md)。

复现命令：

```bash
pnpm --filter @ai-lab/ai-core eval:suite
```

报告写入 `packages/ai-core/evals/reports/`（已被 `.gitignore` 忽略），JSON 保留每条模型原始输出。

## 四、第 3～4 周复盘

### 4.1 解决了什么

- 从「能调用模型」推进到「可维护的模型应用」：模板、档案、结构化、流式、工具、可靠性、评测逐层补齐。
- 把模型差异收敛在 `ChatTransport` 之后，业务层不感知供应商。
- 把「答错」和「没答」分开统计，避免把供应商故障误判为 Prompt 退化。

### 4.2 三个关键取舍

| 问题 | 选择 | 原因 | 代价 |
| --- | --- | --- | --- |
| Prompt 放前端还是服务端 | 服务端模板 ID | 防注入、可版本化 | 新增模板需发版 |
| 历史全带还是摘要 | 预算内 recent + 增量摘要 | 控制 Token 与延迟 | 摘要会丢细节 |
| 评测用裁判模型还是规则 | 确定性规则 | 可复现、零额外成本 | 无法评价语义质量 |

### 4.3 踩坑与修复

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| 评测 Prompt 与生产分叉 | 线上效果与评测结论不一致 | 测试逐字比对生产模板与 `-v2.txt` |
| 空回复被当成成功 | 前端显示空白气泡 | 无内容时抛 `AI_EMPTY_RESPONSE` |
| 重试放大费用 | 400/401 也被反复重试 | 只对超时、网络、429、5xx、空回复重试 |
| 中断仍写半截回答 | 历史出现不完整回复 | 中断后不保存助手消息 |
| 并发下延迟失真 | 评测结果波动大 | 评测串行执行用例 |

### 4.4 四项能力的复盘

| 主题 | 关键结论 | 证据 |
| --- | --- | --- |
| 模型接入 | 业务层只依赖 `ChatTransport`，切换模型与供应商不改业务代码；客户端只能看到公开档案 ID | [model-profiles 测试](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/tests/model-profiles.test.cjs)、[models API](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/ai-models.test.cjs) |
| 结构化输出 | 结构约束交给 Zod，模型只负责生成；失败时把「为什么不合格」写回提示，只重试一次 | [structured-output 测试](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/tests/structured-output.test.cjs) |
| 工具调用 | 模型只能选择白名单工具，参数必须二次校验；循环必须有硬上限，否则可能不终止 | [tools 测试](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/tools.test.cjs) |
| 评估方法 | 固定测试集保证可比；准确率、成功率、失败率与延迟分开统计，结论才能归因 | [day5 文档](file:///d:/StudyAI/ai-fullstack-lab/docs/week4/day5-测试与评估.md) |

## 五、交付物索引

| 交付物 | 路径 |
| --- | --- |
| 架构图与链路 | [docs/architecture/ai-chat-v1.md](file:///d:/StudyAI/ai-fullstack-lab/docs/architecture/ai-chat-v1.md) |
| API 文档 | [docs/api/ai-chat-v1.md](file:///d:/StudyAI/ai-fullstack-lab/docs/api/ai-chat-v1.md) |
| 测试报告 | 本文第三节 |
| 20 条测试集 | [prompt-suite-20.json](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/evals/datasets/prompt-suite-20.json) |
| 评测脚本 | [run.cjs](file:///d:/StudyAI/ai-fullstack-lab/packages/ai-core/evals/run.cjs) |
| 每日学习记录 | [docs/week4](file:///d:/StudyAI/ai-fullstack-lab/docs/week4) |
| 演示脚本 | 本文第七节（视频待录制） |

## 六、验收环境准备

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量（不要提交 .env）
#    需要：MODEL_API_KEY、DATABASE_URL、JWT_SECRET、JWT_REFRESH_SECRET
cp apps/api/.env.example apps/api/.env

# 3. 初始化数据库
pnpm --filter @ai-lab/api db:deploy
pnpm --filter @ai-lab/api db:generate

# 4. 启动 web(5173) + api(9527)
pnpm dev

# 5. 打开
#    前端：http://localhost:5173
#    Swagger：http://localhost:9527/docs
#    健康检查：http://localhost:9527/api/health
```

录制前确认：

- [ ] `/api/health` 返回 `status: ok` 且 `version: 1.0.0`
- [ ] 已注册至少一个账号，并有一个包含历史消息的会话
- [ ] `MODEL_API_KEY` 可用，单轮与流式都能返回内容
- [ ] 浏览器缩放 100%，关闭无关通知与书签栏
- [ ] 准备 2～3 个演示问题，避免现场输入长文本

## 七、演示视频脚本（3～5 分钟）

### 7.1 分镜

| 时间 | 画面 | 操作与讲解 |
| --- | --- | --- |
| 0:00–0:25 | 首页 | 介绍项目：Vue3 + NestJS + PostgreSQL + DeepSeek；指出首页健康检查与版本 `1.0.0`，说明密钥只在服务端 |
| 0:25–0:50 | 登录页 | 演示登录失败一次（错误码提示），再成功登录，说明 access/refresh 与路由守卫 |
| 0:50–1:40 | `/chat` | 新建会话，提一个技术问题；展示逐字流式输出；中途点「停止生成」，说明半截回复不落库 |
| 1:40–2:20 | `/chat` | 切换模型（Chat / Reasoner）再问一次；展示右侧今日用量与最近调用记录 |
| 2:20–2:50 | 首页面板 | 切换 Prompt 模板：客服 → 摘要 → 分类，说明模板是服务端协议字段，客户端不能提交提示词 |
| 2:50–3:25 | Swagger `/docs` | 调 `POST /api/ai/tools/chat`，展示 `toolRuns`；调 `POST /api/ai/classify`，展示 `attempts` 与结构化结果 |
| 3:25–3:55 | 终端 | 运行 `pnpm --filter @ai-lab/ai-core eval:suite`，展示准确率、成功率、P50/P95 与 v1→v2 对比 |
| 3:55–4:20 | 文档 | 快速展示架构图、API 文档与测试报告，说明下一步进入 RAG |

### 7.2 讲解要点

1. **为什么流式**：首字延迟决定体感；SSE 比 WebSocket 简单，且能穿透代理。
2. **为什么服务端管 Prompt**：客户端只能传模板 ID，防止注入与提示词泄露。
3. **为什么历史要摘要**：模型窗口有限，全量回放既贵又慢；摘要游标避免重复压缩。
4. **为什么工具要白名单**：模型只能选已登记工具，参数还要 Zod 校验，权限不交给模型。
5. **为什么要评测**：没有固定测试集，就无法判断一次 Prompt 修改是变好还是变坏。

### 7.3 录制命令

```bash
# 终端演示：真实评测（会消耗 Token）
pnpm --filter @ai-lab/ai-core eval:suite

# 单独演示某一版
node packages/ai-core/evals/run.cjs \
  --dataset evals/datasets/prompt-suite-20.json \
  --variant classify-v2
```

推荐用 OBS 或系统录屏，分辨率 1920×1080，麦克风单独降噪；视频与仓库分开存放，不提交大文件。

## 八、已知限制与技术债

- **演示视频未录制**：需要本地数据库、模型密钥与录屏环境，仓库只保留脚本。
- **可靠性只在单进程内**：并发信号量、熔断与登录限流都是进程内存实现，多实例部署需要 Redis。
- **用量按服务器本地时区统计**：跨时区部署时“今日”边界会偏移。
- **摘要质量依赖模型**：摘要失败会降级为原文裁剪，但摘要本身可能遗漏事实。
- **文件上传落本地磁盘**：MIME 由客户端声明，尚未校验文件头；生产应改用对象存储与签名 URL。
- **无 E2E 与 CI**：当前是单元/集成测试，尚未覆盖浏览器端到端流程与自动发布门禁。
- **评测样本小**：20 条、单次运行，只能发现明显回归，不能代表全部线上流量。
- **未做真实部署验证**：Docker、Nginx 与子路径部署留到第 14 周。

## 九、自测题

1. 为什么 AI Chat v1.0 的错误码要单独设计，而不是直接返回供应商错误？
2. 多轮对话为什么先保存用户消息，再调用模型？
3. 工具调用中，模型无法调用未登记工具，这属于哪一层防护？
4. 评测里为什么延迟只统计调用成功的用例？
5. 如果要支持多实例部署，可靠性层最先需要改什么？

### 参考答案

1. 供应商错误包含英文短语、状态码甚至内部信息，既不稳定也可能泄露细节。统一错误码让前端可以分支处理、日志可以统计，并且错误文案可以独立修改。
2. 模型调用可能失败或用户可能中断；先落库保证用户输入不丢，刷新后仍能看到自己说过什么，同时为后续重试保留上下文。
3. 属于服务端工具注册表白名单防护。权限判断在服务端完成，模型只负责“提出调用请求”，不能决定自己能调用什么。
4. 失败请求的耗时由超时阈值决定，反映的是故障而不是模型速度；混入平均值会把网络故障误读成模型变慢。
5. 把信号量、熔断状态与登录限流迁移到 Redis 等共享存储；否则每个实例各自计数，整体并发与熔断阈值会成倍放大。

## 十、今日三行

- 今天解决了什么问题：完成 AI Chat v1.0 的版本发布、架构图、API 文档、测试报告与演示脚本，并复跑全部测试与构建。
- 为什么这样设计：把「契约、链路、验证」分开沉淀，架构图解释为什么这样分层，API 文档固定客户端契约，测试报告给出可复现的质量证据。
- 还有什么不确定：演示视频尚未录制；多实例下的可靠性、真实部署与前端 E2E 仍是下一阶段的技术债。
