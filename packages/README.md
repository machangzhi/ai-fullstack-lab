# packages

存放与具体应用无关、可复用的能力库，被 `apps/api` 引用。

| 目录 | 说明 | 关键内容 |
| --- | --- | --- |
| [ai-core](./ai-core/README.md) | 模型接入层 | ModelProvider、Prompt、工具抽象 |
| [rag](./rag/README.md) | 检索增强 | 文档解析、切片、Embedding、检索 |
| [agent](./agent/README.md) | Agent 编排 | LangGraph 工作流、工具循环、审批 |

## 约定

- 不依赖 `apps/*`，保持单向依赖：`apps → packages`。
- 每个包独立导出公共 API，避免深路径引用内部实现。
- 类型定义对外暴露，调用方不重复声明 DTO。
- 模型、向量库等外部依赖通过接口注入，便于替换供应商与本地测试。

## 开发任务清单

- [ ] 建立三个包的构建与导出方式（tsconfig、入口、公共类型）
- [ ] 先完成 `ai-core` 的 Provider 与工具抽象，再被 `rag`、`agent` 复用
- [ ] 各包提供可独立运行的测试与 Mock，不依赖真实模型与网络
- [ ] 为每个包补充最小使用示例

## 验收标准

- [ ] 三个包均不依赖 `apps/*`，依赖方向保持单向
- [ ] `pnpm build` 可按依赖顺序完成构建
- [ ] 包内单测在无网络、无密钥环境下可跑通
- [ ] 每个包有明确的公共 API 列表与版本变更说明
