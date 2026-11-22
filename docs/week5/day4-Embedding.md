# Week 5 Day 4：Embedding

> 目标：把 chunk 文本变成可比较的向量，掌握维度、余弦相似度与批量调用，并把 100 条文本的向量与元数据落盘。
>
> 产物：`packages/rag` 新增 Embedding 配置、HTTP 客户端、批处理、余弦相似度与 CLI；新增 17 项离线测试。

## 一、Embedding 在做什么

Embedding 把一段文本映射成一个固定长度的浮点数组：

```text
"差旅住宿标准" → [0.013, -0.204, 0.887, ...]   // 1024 维
"住宿报销上限" → [0.021, -0.198, 0.862, ...]   // 与上一句方向接近
"今天天气不错" → [-0.431, 0.552, -0.117, ...]  // 方向明显不同
```

三个关键事实：

1. **维度由模型决定**：`text-embedding-3-small` 默认 1536 维，`bge-m3` 是 1024 维。同一批向量必须同维度。
2. **语义接近表现为方向接近**：所以用余弦相似度，而不是逐维比较。
3. **不同模型的向量不可比较**：模型 A 的 1024 维和模型 B 的 1024 维毫无关系，换模型必须重建索引。

## 二、为什么 Embedding 要独立配置

聊天模型用 DeepSeek，不代表 Embedding 也能用 DeepSeek。DeepSeek 的聊天接口不提供 Embeddings，实际项目里常见组合是：

| 用途 | 供应商 | 模型示例 | 默认维度 |
| --- | --- | --- | --- |
| 聊天 | DeepSeek | `deepseek-chat` | — |
| Embedding | OpenAI | `text-embedding-3-small` | 1536 |
| Embedding | SiliconFlow | `BAAI/bge-m3` | 1024 |
| Embedding | DashScope 兼容模式 | `text-embedding-v3` | 1024 |

如果复用 `MODEL_*` 配置，会出现两个问题：换聊天模型时误改索引维度；把聊天密钥发给不支持的端点。因此新增独立的 `EMBEDDING_*` 变量。

## 三、配置

实现位置：[config.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/embedding/config.ts)，示例见 [.env.example](file:///d:/StudyAI/ai-fullstack-lab/apps/api/.env.example)。

| 变量 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- |
| `EMBEDDING_API_KEY` | 无 | 必填 | 只放服务端 |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | http/https，不能带账号密码 | 兼容 OpenAI 的地址 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 非空 | 模型名 |
| `EMBEDDING_DIMENSIONS` | 空 | 1~8192 的整数 | 可选降维；空表示模型默认 |
| `EMBEDDING_BATCH_SIZE` | 16 | 1~128 | 单次请求文本数 |
| `EMBEDDING_TIMEOUT_MS` | 30000 | 1000~120000 | 单次请求超时 |

非法配置直接抛 `INVALID_CONFIG`，不静默回退。配置错误越早暴露越好，否则会在索引到一半时失败。

## 四、请求协议

客户端实现：[client.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/embedding/client.ts)

```http
POST {EMBEDDING_BASE_URL}/embeddings
Authorization: Bearer <EMBEDDING_API_KEY>
Content-Type: application/json

{
  "model": "text-embedding-3-small",
  "input": ["第一段文本", "第二段文本"],
  "encoding_format": "float",
  "dimensions": 512
}
```

响应：

```json
{
  "model": "text-embedding-3-small",
  "data": [
    { "index": 0, "embedding": [0.01, -0.02, 0.03] },
    { "index": 1, "embedding": [0.04, 0.05, -0.06] }
  ],
  "usage": { "prompt_tokens": 12, "total_tokens": 12 }
}
```

### 4.1 为什么必须校验响应

供应商的返回顺序不保证与输入一致，也不保证条数完整。如果直接按下标使用，可能出现「第一段文本拿到第二段向量」，索引看起来成功，检索结果却全错。

客户端做四项检查：

| 检查 | 失败后果 | 错误码 |
| --- | --- | --- |
| 返回条数等于请求条数 | 少一条就错位 | `INVALID_RESPONSE` |
| `index` 覆盖 0..n-1 且不重复 | 顺序错乱 | `INVALID_RESPONSE` |
| 每条向量非空且全为有限数值 | NaN 会污染相似度 | `INVALID_RESPONSE` |
| 同一批向量维度一致 | 维度混用无法比较 | `INVALID_RESPONSE` |

最终按 `index` 排序后再返回，调用方拿到的顺序与输入严格一致。

## 五、批量调用

实现位置：[embed.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/embedding/embed.ts)

100 条文本、批量 16 时：

```text
16 + 16 + 16 + 16 + 16 + 16 + 4 = 100
共 7 次请求
```

批处理负责：

- 按 `batchSize` 切分，逐批顺序发送；
- 把每批向量按全局序号拼回去；
- 累计 Token 与耗时；
- 每批结束回调进度，CLI 可以实时输出；
- 跨批维度不一致立即失败。

顺序发送而不是并发，是为了避免瞬时打满供应商限流。代价是总耗时等于各批之和；后续可以加并发上限，但要与限流策略一起设计。

## 六、余弦相似度

实现位置：[similarity.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/embedding/similarity.ts)

```text
cos(a, b) = (a · b) / (|a| × |b|)
```

取值范围 `[-1, 1]`：

- `1`：方向完全相同；
- `0`：无关；
- `-1`：方向相反；
- 零向量：返回 `0`，避免除零得到 `NaN`。

为什么不用欧氏距离：文本越长，向量模长往往越大，欧氏距离会被长度干扰；余弦只看向量夹角，更适合语义比较。

注意：相似度分数只在**同一个模型**内有意义。不能拿 OpenAI 的 0.8 和 bge-m3 的 0.8 比较。

## 七、保存向量与元数据

[embedding-corpus.json](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/evals/datasets/embedding-corpus.json) 提供 100 条唯一文本，覆盖差旅、报销、发票、住宿、交通、审批、考勤、休假、IT 安全等主题。

运行：

```bash
pnpm --filter @ai-lab/rag embed:corpus
# 只跑 20 条、每批 8 条
pnpm --filter @ai-lab/rag embed:corpus -- --limit 20 --batch-size 8
```

脚本 [embed-corpus.cjs](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/scripts/embed-corpus.cjs) 会：

1. 读取 `apps/api/.env` 或当前环境变量；
2. 校验配置，读取并截取 100 条文本；
3. 逐批调用，打印每批耗时；
4. 写入 `packages/rag/reports/embeddings-<时间>.json`。

报告结构：

```json
{
  "createdAt": "2026-11-22T12:00:00.000Z",
  "model": "BAAI/bge-m3",
  "dimensions": 1024,
  "batchSize": 16,
  "count": 100,
  "usage": { "promptTokens": 1420, "totalTokens": 1420 },
  "latencyMs": 4380,
  "batches": [
    { "index": 0, "count": 16, "latencyMs": 620, "usage": { "promptTokens": 228, "totalTokens": 228 } }
  ],
  "items": [
    {
      "index": 0,
      "text": "员工出差前需在系统中提交出差申请……",
      "tokenCount": 26,
      "vector": [0.0123, -0.0456, 0.0789]
    }
  ]
}
```

报告不包含 API Key 与 Base URL；`packages/rag/reports/` 已加入 `.gitignore`，因为完整向量体积大，属于本地调试产物。

### 7.1 本日没有真实调用

当前环境没有 `EMBEDDING_API_KEY`，所以没有生成真实向量报告。批处理、协议解析与 100 条分批逻辑由 Mock 测试覆盖；配置好密钥后执行上面的命令即可得到真实报告。

CLI 另外用本地 Mock 服务做过一次端到端冒烟：100 条文本、7 批、报告 `count=100`、`dimensions=4`，字段包含 `index/text/vector/tokenCount`。该报告仅用于验证流程，已删除，不作为真实评测结果。

## 八、测试

测试文件：[embedding.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/tests/embedding.test.cjs)

| 分组 | 用例 |
| --- | --- |
| 配置 | 默认值、自定义与去尾斜杠、缺密钥、非法地址/协议/凭证、越界数值、错误不泄露密钥 |
| HTTP 客户端 | 请求体与鉴权头、按 index 排序、维度参数、401、非 JSON、数量/数值非法、网络异常 |
| 批处理 | 100 条按 16 分批（7 批）、序号与用量、空输入、跨批维度不一致 |
| 余弦 | 同向/正交/反向、零向量、维度不一致 |

所有用例使用 Mock fetch / Mock client，不访问网络、不需要密钥。

## 九、验证结果

| 检查 | 结果 |
| --- | --- |
| `@ai-lab/rag` 测试 | 36/36 通过（解析 8 + 切片 11 + Embedding 17） |
| `@ai-lab/ai-core` 测试 | 64/64 通过 |
| `@ai-lab/api` 测试 | 62/62 通过 |
| 全仓库 lint | 0 error（64 个前端模板 warning） |
| 全仓库 typecheck | 4 个包全部通过 |
| 全仓库 build | 4 个包全部通过 |
| CLI 冒烟（本地 Mock） | 100 条 / 7 批 / 报告字段完整 |
| 数据集 | 100 条，唯一 100 条 |

## 十、已知限制

- **没有重试与退避**：429、5xx 直接失败；索引大批量时需要在外层加有限重试。
- **顺序调用**：总延迟是各批之和，未做并发；并发需要与供应商限流一起设计。
- **按条数分批，不按 Token**：一条超长文本仍可能超过模型输入上限。
- **没有缓存与去重**：重复文本会重复计费。
- **不归一化向量**：相似度用余弦，归一化不是必需；但后续换内积检索时需要统一。
- **只落盘 JSON**：数据库与 pgvector 在 Day 5 完成；报告适合调试，不适合生产查询。
- **报告含完整向量**：100 条 1024 维约数 MB，已忽略提交。
- **未验证所有供应商**：只按 OpenAI Embeddings 协议实现，供应商差异需要真实调用验证。
- **Token 是估算**：报告里的 `tokenCount` 来自本地估算；`usage` 才是供应商返回的权威值。
- **换模型必须重建索引**：当前没有模型迁移或版本标记机制。

## 十一、自测题

1. 为什么 Embedding 不能复用聊天模型的 `MODEL_*` 配置？
2. 供应商返回的 `data` 顺序为什么不能直接相信？客户端应该怎么处理？
3. 100 条文本、批量 16，一共几次请求？最后一批多少条？
4. 余弦相似度为什么比欧氏距离更适合文本向量？
5. 两批向量维度不一致时，为什么必须失败而不是截断对齐？

### 参考答案

1. 聊天与 Embedding 往往是不同供应商、不同模型、不同维度；复用配置会在换聊天模型时误改索引维度，也可能把密钥发到不支持 Embedding 的端点。
2. 协议只保证 `index` 标识位置，不保证数组顺序；必须按 `index` 排序，并校验 0..n-1 完整且不重复，否则会出现文本与向量错位。
3. 7 次：6 次 16 条，最后 1 次 4 条。
4. 文本越长，向量模长通常越大，欧氏距离会被长度影响；余弦只看向量夹角，对长度不敏感，更接近语义相似。
5. 维度不同意味着向量空间不同，截断或补零会产生没有语义的坐标，相似度完全失真；必须视为配置或数据错误，整批失败并重建索引。

## 十二、今日三行

- 今天解决了什么问题：新增独立的 Embedding 配置、OpenAI 兼容客户端、100 条批处理、余弦相似度与向量落盘 CLI，并用 Mock 覆盖协议与分批逻辑。
- 为什么这样设计：Embedding 与聊天模型解耦，避免换模型误改索引；严格校验条数、index 与维度，宁可失败也不接受错位向量。
- 还有什么不确定：真实供应商的限流与维度差异、单条文本的 Token 上限、并发批量是否值得，需要配置密钥后用真实语料验证。
