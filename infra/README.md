# infra

部署与运行环境配置：容器化、编排、反向代理与持续集成。

## 职责

- Docker：`apps/web`、`apps/api` 的镜像构建（多阶段构建、非 root 运行）
- Docker Compose：应用 + PostgreSQL(pgvector) + 可选向量/缓存服务的本地一键启动
- 环境配置：各环境的 `.env.example`、配置项说明
- 部署：反向代理、HTTPS、静态资源与上传目录挂载
- CI：安装依赖、Lint、测试、构建、镜像发布

## 规划结构（示意）

```text
infra/
├─ docker/            # Dockerfile、compose 配置
├─ env/               # 各环境变量模板
├─ nginx/             # 反向代理与流式响应（SSE）配置
└─ ci/                # 流水线配置
```

## 约定

- 镜像只包含运行所需内容，构建产物与依赖分层缓存。
- 密钥由部署环境注入，不进入镜像、不提交仓库。
- SSE / 流式接口需关闭代理缓冲，并配置足够的超时时间。
- 部署脚本需可重复执行，具备基本的健康检查与回滚方式。

## 开发任务清单

- [ ] 为 web、api 编写多阶段 Dockerfile，非 root 运行
- [ ] Docker Compose 编排 web + api + PostgreSQL(pgvector)，配置 Volume 持久化
- [ ] 环境变量模板与配置校验，开发/测试/生产隔离
- [ ] Nginx 反向代理：API 转发、SSE 关闭缓冲、长连接超时、上传目录
- [ ] CI：PR 触发 lint、单测、构建，密钥走 Secrets
- [ ] 健康检查与启动顺序（等待数据库就绪）
- [ ] 结构化日志、镜像标记与部署/回滚说明

## 验收标准

- [ ] 干净环境按部署说明一条命令启动全部服务
- [ ] 容器重启后数据不丢失（数据库与上传文件位于 Volume）
- [ ] 经 Nginx 的 SSE 长连接不被缓冲，5 分钟以上不中断
- [ ] 健康检查通过，依赖未就绪时服务不会误启动
- [ ] CI 在 PR 上运行 lint/test/build 并通过
- [ ] 仓库与镜像中均无密钥，仅存在 `.env.example`
- [ ] 部署与回滚步骤可重复执行
