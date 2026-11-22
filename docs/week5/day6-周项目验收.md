# Week 5 Day 6：知识库 Ingestion 与周项目验收

> 目标：把「上传 → 解析 → 切片 → 向量化 → 入库 → 检索」串成一条可调用链路，并完成 Week 5 验收。
>
> 产物：`POST /api/knowledge/documents`、`POST /api/knowledge/search`、`KnowledgeService` 编排层与 8 项离线测试。

## 一、链路总览

```text
multipart 文件
   │  Multer memoryStorage，10MB 上限，类型白名单
   ▼
parseDocument        解析 PDF / DOCX / TXT / Markdown，保留页码与标题路径
   ▼
chunkDocument        按文档格式选择 recursive / markdown 策略
   ▼
EmbeddingGateway      读取 EMBEDDING_*，批量调用，校验维度与条数
   ▼
VectorStoreService   事务写入 documents + document_chunks（vector(1536)）
   ▼
响应：文档 ID、切片数、模型、Token、各阶段耗时
```

查询链路：

```text
问题 → Embedding → pgvector Top-K（余弦距离）→ 命中片段 + 来源 + 相似度
```

两条链路共用同一套切片契约与 `VectorSearchHit` 来源字段，因此检索结果可以直接用于 Week 6 的引用回答。

## 二、接口

### 2.1 上传并入库

```http
POST /api/knowledge/documents
Authorization: Bearer <access_token>
Content-Type: multipart/form-data
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file` | binary | `.pdf` / `.docx` / `.txt` / `.md` / `.markdown`，最大 10MB |

成功响应（统一响应包已省略外层）：

```json
{
  "documentId": "cm8...",
  "title": "差旅制度",
  "filename": "travel.md",
  "format": "markdown",
  "status": "READY",
  "blockCount": 12,
  "charCount": 2860,
  "chunkCount": 6,
  "chunkStrategy": "markdown",
  "embeddingModel": "text-embedding-3-small",
  "dimensions": 1536,
  "usage": { "promptTokens": 1420, "totalTokens": 1420 },
  "warnings": [],
  "metrics": {
    "parseMs": 18,
    "chunkMs": 4,
    "embedMs": 860,
    "storeMs": 120,
    "totalMs": 1002
  }
}
```

实现：[knowledge.controller.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/knowledge.controller.ts)、[knowledge.service.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/knowledge.service.ts)

### 2.2 检索调试

```http
POST /api/knowledge/search
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "query": "一线城市住宿标准是多少？",
  "topK": 5,
  "documentId": "cm8...",
  "minSimilarity": 0.4
}
```

| 参数 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- |
| `query` | 是 | 1~500 字符 | 检索问题 |
| `topK` | 否 | 1~20，默认 5 | 返回条数 |
| `documentId` | 否 | 1~64 字符 | 只检索指定文档 |
| `minSimilarity` | 否 | 0~1 | 最低余弦相似度 |

响应：

```json
{
  "query": "一线城市住宿标准是多少？",
  "hits": [
    {
      "chunkId": "chunk...",
      "documentId": "cm8...",
      "documentTitle": "差旅制度",
      "filename": "travel.md",
      "chunkIndex": 2,
      "content": "一线城市住宿标准为每晚六百元……",
      "page": null,
      "pageEnd": null,
      "sectionPath": ["差旅制度", "住宿标准"],
      "blockIndexes": [4, 5],
      "tokenCount": 96,
      "similarity": 0.87
    }
  ],
  "meta": {
    "embeddingModel": "text-embedding-3-small",
    "dimensions": 1536,
    "embeddingMs": 210,
    "searchMs": 18,
    "totalMs": 228,
    "usage": { "promptTokens": 12, "totalTokens": 12 }
  }
}
```

`similarity` 已由「余弦距离」转换为 `1 - distance`，越大越相似。

### 2.3 鉴权与限制

- 两个接口都挂 `JwtAuthGuard`，未登录返回 401。
- 文件只在内存中处理，不落本地磁盘，失败不会留下孤儿文件。
- 扩展名与 MIME 双重白名单；大小超过 10MB 返回 413 `PAYLOAD_TOO_LARGE`。
- 当前没有角色限制：任何登录用户都能上传，权限隔离留到 Week 7。

## 三、编排层的设计

### 3.1 为什么拆出 EmbeddingGateway

`KnowledgeService` 不应该关心：

- 环境变量名与默认值；
- OpenAI 兼容请求体；
- 批量大小与 HTTP 超时。

这些收敛到 [embedding.gateway.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/embedding.gateway.ts)。测试时直接替换成 Mock，不需要密钥与网络。

### 3.2 维度校验发生两次

第一次在 Embedding 包内部：同一批响应必须条数一致、维度一致。

第二次在写库前：所有向量必须等于 `VECTOR_DIMENSION = 1536`。

原因：`vector(1536)` 是数据库列的硬约束。如果模型换成 1024 维而没有改迁移，数据库会报错；应用层提前失败可以给出更明确的 `KNOWLEDGE_VECTOR_MISMATCH`。

### 3.3 错误码映射

| 阶段 | 错误码 | HTTP | 说明 |
| --- | --- | --- | --- |
| 上传 | `KNOWLEDGE_EMPTY_FILE` | 400 | 没有文件或文件为空 |
| 上传 | `KNOWLEDGE_UNSUPPORTED_FORMAT` | 400 | 扩展名/MIME 不支持 |
| 解析 | `KNOWLEDGE_EMPTY_DOCUMENT` | 400 | 没有可索引正文 |
| 解析 | `KNOWLEDGE_PARSE_FAILED` | 422 | 文件损坏、加密、编码异常 |
| 切片 | `KNOWLEDGE_EMPTY_DOCUMENT` | 400 | 切片结果为空 |
| Embedding | `KNOWLEDGE_EMBEDDING_UNAVAILABLE` | 503 | 未配置 `EMBEDDING_*` |
| Embedding | `KNOWLEDGE_EMBEDDING_FAILED` | 502 | 网络、限流、响应非法 |
| Embedding | `KNOWLEDGE_VECTOR_MISMATCH` | 503 | 维度与索引不一致 |
| 存储 | `KNOWLEDGE_STORE_UNAVAILABLE` | 503 | 数据库不可用 |
| 检索 | `KNOWLEDGE_INVALID_INPUT` | 400 | query 为空或参数非法 |

客户端只需要按 `code` 分支，不依赖底层库或供应商文案。

## 四、质量检查

### 4.1 解析完整性

| 检查 | 方法 | 异常处理 |
| --- | --- | --- |
| 是否有正文 | `blockCount > 0`、`charCount > 0` | `KNOWLEDGE_EMPTY_DOCUMENT` |
| 块顺序 | 解析器按块递增 `index` | 单元测试覆盖 |
| 页码 | PDF 块带 `page` | 其他格式为 `null` |
| 标题路径 | `sectionPath` 逐块继承 | 切片结果可回溯 |
| 非致命问题 | `warnings` 返回并写入 metadata | 不阻断入库 |

### 4.2 切片质量

Week 5 Day 3 的默认参数：`chunkSize = 600`、`overlap = 80`。

验收时重点看：

- 是否出现只有标题、没有正文的切片；
- 跨页切片是否同时保留 `page` 与 `pageEnd`；
- `sectionPath` 是否指向正确章节；
- 切片数量是否与文档长度大致匹配。

### 4.3 向量维度

- 每条向量长度必须是 1536；
- 数量必须等于切片数；
- 数值必须有限，不能出现 `NaN` / `Infinity`；
- 模型名与维度写入响应和 metadata，方便排查「换了模型没重建索引」。

### 4.4 检索结果

用固定问题验证：

| 问题 | 期望 |
| --- | --- |
| 一线城市住宿标准是多少？ | 命中「住宿标准」切片，similarity 最高 |
| 发票抬头写什么？ | 命中「发票」相关切片 |
| 公司年会在哪开？ | 不应命中，或 similarity 明显偏低 |

若结果异常，按 Day 1 的失败模式排查：解析 → 切片 → 召回 → 生成。

## 五、运行方式

前置条件：

1. PostgreSQL 已启用 pgvector，并执行 Day 5 迁移；
2. `apps/api/.env` 配置 `DATABASE_URL` 与 `EMBEDDING_*`；
3. API 已启动（端口 9527）。

```bash
pnpm --filter @ai-lab/api db:deploy
pnpm --filter @ai-lab/api dev
```

先登录拿 token，再上传：

```bash
curl -X POST http://localhost:9527/api/knowledge/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@docs/week5/day1-RAG全链路.md;type=text/markdown"
```

检索：

```bash
curl -X POST http://localhost:9527/api/knowledge/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"RAG 的索引阶段包含哪些步骤？\",\"topK\":3}"
```

### 5.1 本日没有真实端到端运行

当前环境没有 Docker / PostgreSQL，也没有 `EMBEDDING_API_KEY`，因此：

- 上传与检索接口未做真实 HTTP 调用；
- 未写入真实向量；
- 解析、切片、Embedding 编排、错误映射由 Mock 测试覆盖；
- pgvector SQL 在 Day 5 已做结构与参数验证。

配置好数据库与 Embedding 服务后，按上面的命令即可完成真实验收。

## 六、测试

测试文件：[knowledge.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/knowledge.test.cjs)

| 用例 | 验证点 |
| --- | --- |
| Markdown ingestion | 标题、格式、切片数、向量维度、usage、metadata |
| 缺少 Embedding 配置 | 503，且不写库 |
| Embedding 失败 / 维度不一致 | 502 / 503，且不写库 |
| 空文件 / 不支持格式 | 400，在解析前拦截 |
| 向量库异常 | 503，不泄露底层信息 |
| 检索 | query 去除首尾空白、参数透传、meta 耗时与用量 |
| 空问题 / 维度不一致 | 400 / 503 |
| DTO | 空白 query、`topK` 越界、`minSimilarity` 越界、空白 `documentId` |

所有用例使用 Mock Embedding 与 Mock 向量库，不访问网络、不连接数据库。

## 七、Week 5 验收结果

| 检查 | 结果 |
| --- | --- |
| `@ai-lab/api` 测试 | 78/78 通过（新增 8 项知识库测试） |
| `@ai-lab/rag` 测试 | 36/36 通过 |
| `@ai-lab/ai-core` 测试 | 64/64 通过 |
| 全仓库 lint | 0 error（64 个前端模板 warning） |
| 全仓库 typecheck | 4 个包全部通过 |
| 全仓库 build | 4 个包全部通过 |
| 真实数据库迁移 | 未执行（无 Docker / PostgreSQL） |
| 真实 Embedding | 未调用（无 `EMBEDDING_API_KEY`） |

### 7.1 Week 5 交付清单

- [x] 画出 RAG 索引与查询链路，明确召回/生成边界（Day 1）
- [x] PDF / DOCX / TXT / Markdown 解析，保留页码与标题路径（Day 2）
- [x] Recursive / Markdown 切片，返回序号、来源与 Token 估算（Day 3）
- [x] Embedding 客户端、批量调用与 100 条语料（Day 4）
- [x] pgvector 表、HNSW 索引与 Top-K SQL（Day 5）
- [x] 上传 → 解析 → 切片 → 向量化 → 入库 API（Day 6）
- [x] 检索调试 API，返回来源与相似度（Day 6）
- [ ] 真实数据库 + 真实 Embedding 的端到端演示（待环境配置）

## 八、已知限制

- **同步处理**：上传请求内完成解析与向量化，大文件或慢供应商会让请求持续数十秒；Week 7 会改为后台任务。
- **没有任务状态接口**：当前直接返回 `READY`；异步化后需要 `PENDING` / `FAILED` 查询。
- **没有文档列表与删除接口**：只能上传与检索，管理界面留到 Week 7。
- **没有去重与版本**：同一文件重复上传会生成新文档与新切片。
- **没有角色限制**：任何登录用户都能上传，租户/知识库隔离在 Week 7。
- **文件只放内存**：适合 10MB 以内的文档；更大的文件需要流式解析或对象存储。
- **MIME 白名单较严**：部分浏览器上传 `.md` 会带 `application/octet-stream`，会被拒绝；需要前端显式设置类型或后续放宽规则。
- **无重试**：Embedding 失败直接返回 502，不自动重试；批量 ingestion 需要外层重试。
- **无速率限制**：同一用户可连续上传，可能放大 Embedding 费用。
- **无 Rerank**：只按向量相似度排序，Week 6 会评估改写与重排。
- **固定 1536 维**：换 1024 维模型必须改迁移并重建索引。
- **未真实端到端验证**：本日只验证编排与错误映射，必须在有数据库与密钥的环境补一次。

## 九、自测题

1. 为什么上传文件放内存，而不是先保存到本地磁盘？
2. 为什么当前 ingestion 是同步的？什么情况下必须改成异步任务？
3. 为什么向量维度要在 Embedding 包和写库前各校验一次？
4. 检索为什么只查 `status = READY` 的文档？
5. 上传接口做了哪些安全限制？还缺什么？
6. 检索结果明显不相关时，应该按什么顺序排查？

### 参考答案

1. 解析后立即使用，失败时不需要清理临时文件；也避免把用户文件留在服务器磁盘上。代价是占用内存，所以限制 10MB。
2. 同步实现简单、响应直接；当解析/Embedding 超过网关超时、需要排队、需要进度与失败重试时，必须改成异步任务与状态机。
3. 第一次防止同一批响应内部维度不一致；第二次防止模型维度与数据库列 `vector(1536)`、HNSW 索引不一致。两者失败位置与修复动作不同。
4. READY 表示解析、切片、向量化全部完成；PENDING/FAILED 文档的切片不完整，返回给用户会破坏引用可信度。
5. 已做 JWT 鉴权、扩展名与 MIME 白名单、10MB 限制、内存存储、错误脱敏；还缺角色/租户隔离、速率限制、病毒扫描与内容安全。
6. 先看解析是否完整（blockCount、warnings），再看切片是否切断关键句与标题路径，再看 Embedding 模型/维度是否一致，最后看检索参数（topK、阈值）与是否需要 Rerank。

## 十、今日三行

- 今天解决了什么问题：把上传、解析、切片、Embedding、pgvector 入库与 Top-K 检索串成两个可调用接口，并统一了阶段错误码与耗时指标。
- 为什么这样设计：Embedding 网关与向量库都可替换，编排层只负责顺序与校验；文件放内存、维度写库前复核、只检索 READY，保证失败可控、引用可信。
- 还有什么不确定：真实文件与真实供应商下的延迟、超大文档的内存占用、MIME 兼容性与检索质量，需要在配置好数据库和密钥后做端到端验收。
