# mcp-servers

自建 MCP（Model Context Protocol）Server，让 Agent 通过标准协议连接外部工具与数据。

## 职责

- 基于 TypeScript SDK 实现 Server：工具注册、输入 Schema、错误返回
- 提供基础工具：时间查询、计算器、只读业务查询
- 资源与提示词（Resources / Prompts）的暴露方式
- 安全控制：工具白名单、参数校验、权限边界、只读优先
- 与 `apps/api` 中的 MCP Client 联调，支持工具动态发现与断连处理

## 规划结构（示意）

```text
mcp-servers/
├─ time/        # 时间查询
├─ calculator/  # 计算器
└─ readonly-db/ # 只读业务查询
```

## 约定

- 默认只提供只读工具；写操作必须显式授权并记录审计信息。
- 每个工具的输入必须定义 Schema 并做校验，错误以结构化形式返回。
- 单个 Server 职责单一，避免把不同领域工具堆在一个进程里。

## 开发任务清单

- [ ] 用 TypeScript SDK 搭建 Server 骨架（工具注册、输入 Schema、错误返回）
- [ ] 实现时间查询、计算器两个基础 Server
- [ ] 实现只读业务查询 Server（客户/订单/指标模拟数据）
- [ ] 工具元数据：名称、描述、输入 Schema、超时、只读标记
- [ ] 安全：工具白名单、身份认证、权限映射、输入校验、审计
- [ ] 在 `apps/api` 实现 MCP Client：连接、发现工具、调用、断连处理
- [ ] 接入 LangGraph，至少两个 Server 的工具可被调用
- [ ] 输出工具目录与演示文档

## 验收标准

- [ ] Client 可动态发现 Server 工具并生成 Agent 可用的工具定义
- [ ] 非法参数返回结构化错误，Server 不崩溃
- [ ] 未授权或非白名单工具调用被拒绝，并记录审计
- [ ] 断连、超时有明确错误提示并可重连
- [ ] 不存在任意命令执行或无约束文件访问工具
- [ ] 至少两个 Server 在 LangGraph 中完成端到端调用演示
