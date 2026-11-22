# Week 5 Day 5：向量数据库

> 目标：用 PostgreSQL + pgvector 持久化文档切片，建立 HNSW 索引，并完成按余弦相似度排序的 Top-K 检索。
>
> 产物：`documents` / `document_chunks` 表、迁移 SQL、`VectorStoreService` 与 8 项离线测试。

## 一、为什么需要向量数据库

Day 4 已经能拿到向量，但把 100 条向量放在 JSON 里只能做实验：

| 问题 | 内存 / JSON | 数据库 |
| --- | --- | --- |
| 进程重启 | 数据丢失 | 持久化 |
| 按文档过滤 | 自己遍历 | SQL `WHERE` |
| 并发写入 | 需要自己加锁 | 事务与约束 |
| 相似度检索 | 全量循环 | 索引 + `ORDER BY` |
| 引用来源 | 额外维护映射 | 与文档表关联 |

pgvector 的价值是把「向量列 + 距离运算符 + 近似索引」放进 PostgreSQL，业务数据与向量可以在同一个事务里维护。

## 二、pgvector 的三个核心概念

### 2.1 向量列

```sql
embedding vector(1536)
```

`vector(1536)` 表示固定 1536 维。维度固定后：

- 数据库可以拒绝错误维度的写入；
- 可以建立 HNSW / IVFFlat 索引；
- 查询时 `<=>` 两边的维度必须一致。

### 2.2 距离运算符

| 运算符 | 含义 | 何时用 |
| --- | --- | --- |
| `<->` | 欧氏距离（L2） | 向量已归一化或长度有意义 |
| `<=>` | 余弦距离 = `1 - 余弦相似度` | 文本语义检索（本项目） |
| `<#>` | 负内积 | 已归一化向量，追求速度 |

本项目选余弦：

- 文本越长，向量模长往往越大，欧氏距离会被长度影响；
- 余弦只看向量夹角，更接近「语义方向是否一致」；
- 返回值是距离：`0` 最相似，`2` 最不相似；展示时转成 `1 - distance`。

### 2.3 索引

| 索引 | 构建 | 优点 | 缺点 |
| --- | --- | --- | --- |
| HNSW | 不需要训练数据 | 召回高、查询快 | 建索引慢、占内存 |
| IVFFlat | 需要先有数据做聚类 | 构建快、内存低 | 需要调 `lists`，召回依赖数据分布 |

本项目用 HNSW：

```sql
CREATE INDEX "document_chunks_embedding_hnsw_idx"
  ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
```

注意：**小表不一定走索引**。几十条数据时 PostgreSQL 往往选择顺序扫描，这是正常的；数据量上来后 `EXPLAIN ANALYZE` 才会看到 HNSW Index Scan。

## 三、数据模型

实现位置：[schema.prisma](file:///d:/StudyAI/ai-fullstack-lab/apps/api/prisma/schema.prisma)、[migration.sql](file:///d:/StudyAI/ai-fullstack-lab/apps/api/prisma/migrations/20261122130000_add_documents_and_chunks/migration.sql)

### 3.1 documents

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT | cuid 主键 |
| `title` | TEXT | 文档标题 |
| `filename` | TEXT | 原始文件名 |
| `mimeType` | TEXT | 上传时的 MIME |
| `format` | TEXT | `pdf` / `docx` / `txt` / `markdown` |
| `status` | enum | `PENDING` / `READY` / `FAILED` |
| `charCount` | INT | 正文字符数 |
| `blockCount` | INT | 解析块数 |
| `metadata` | JSONB | 解析器返回的来源信息 |
| `createdAt` / `updatedAt` | TIMESTAMP | 审计时间 |

### 3.2 document_chunks

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT | 主键 |
| `documentId` | TEXT | 外键，级联删除 |
| `chunkIndex` | INT | 文档内顺序 |
| `content` | TEXT | 切片正文 |
| `page` / `pageEnd` | INT? | PDF 页码 |
| `sectionPath` | JSONB | 标题路径 |
| `blockIndexes` | JSONB | 来源块序号 |
| `tokenCount` | INT | 估算 Token |
| `embedding` | vector(1536) | 向量 |
| `createdAt` | TIMESTAMP | 写入时间 |

两个约束值得注意：

- `UNIQUE(documentId, chunkIndex)`：同一文档内序号不能重复，避免重复索引；
- `ON DELETE CASCADE`：删除文档自动清理切片，不会留下孤儿向量。

### 3.3 为什么维度写死 1536

pgvector 的列类型和 HNSW 索引都需要固定维度，不能在同一列里混用 1024 与 1536。

当前选择与 `.env.example` 默认的 `text-embedding-3-small` 对齐：

```text
text-embedding-3-small → 1536 维
bge-m3                 → 1024 维
```

如果换成 bge-m3，必须同时修改：

1. Prisma schema 的 `Unsupported("vector(1024)")`；
2. 新迁移里的 `vector(1024)`；
3. 重建所有向量与 HNSW 索引。

不要在旧索引上直接混入新维度，距离计算会失败或得到无意义结果。

## 四、迁移

迁移文件顶部先启用扩展：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

执行：

```bash
pnpm --filter @ai-lab/api db:migrate
# 生产环境只应用已有迁移，不生成新迁移
pnpm --filter @ai-lab/api db:deploy
```

前置条件：

- PostgreSQL 已安装 pgvector 扩展（>= 0.5 才支持 HNSW）；
- 当前数据库用户有 `CREATE EXTENSION` 权限，否则需要 DBA 预先执行；
- 使用 `pgvector/pgvector:pg16` 这类自带扩展的镜像最省事。

### 4.1 本日没有在真实数据库执行

当前环境没有 Docker，也没有本地 PostgreSQL（5432 / 55432 均未监听），因此：

- `prisma validate` 通过；
- `prisma generate` 通过；
- 迁移 SQL 未实际执行；
- Top-K SQL 由 Fake Prisma 验证了参数与结构，但没有经过真实 pgvector。

配置好数据库后按下一节手工验证。

## 五、写入：文档 + 切片同一事务

实现位置：[vector-store.service.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/vector-store.service.ts)

```ts
await prisma.$transaction(async (tx) => {
  const document = await tx.document.create({ data: { ... } });

  for (const chunk of input.chunks) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "document_chunks" (...)
      VALUES (..., ${toVectorLiteral(chunk.embedding)}::vector)
    `);
  }
});
```

为什么用事务：

- 切片写到一半失败时，不能留下「有文档、没向量」的半成品；
- `chunkIndex` 唯一约束冲突会回滚整个文档，而不是写入部分数据；
- 后续异步 ingestion 可以把状态改为 `PENDING`，全部成功后再 `READY`。

为什么用原生 SQL 写入：

- Prisma Client 不生成 `Unsupported("vector")` 字段的写接口；
- 向量必须经过 `::vector` 转换；
- `sectionPath` / `blockIndexes` 以 JSON 字符串写入 `jsonb`。

## 六、Top-K 检索 SQL

实现位置：[vector-store.sql.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/vector-store.sql.ts)

核心查询：

```sql
SELECT
  dc."id" AS "chunkId",
  dc."content",
  d."title" AS "documentTitle",
  1 - (dc."embedding" <=> $1::vector) AS "similarity"
FROM "document_chunks" dc
INNER JOIN "documents" d ON d."id" = dc."documentId"
WHERE d."status" = 'READY'
  AND dc."documentId" = $2
  AND (1 - (dc."embedding" <=> $1::vector)) >= $3
ORDER BY dc."embedding" <=> $1::vector
LIMIT $4;
```

四个参数：

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `$1` | 查询向量 | `[0.1,0.2,...]` 文本，`::vector` 转换 |
| `$2` | `documentId` | 可选；不传时该条件被省略 |
| `$3` | `minSimilarity` | 可选；0~1 |
| `$4` | `topK` | 1~50，默认 5 |

### 6.1 为什么相似度算两次

`similarity` 是 `SELECT` 里的别名，标准 SQL 不能直接在 `WHERE` 中引用别名；所以阈值过滤重复写了一次表达式。数据量大时可以改成子查询：

```sql
SELECT * FROM (
  SELECT ..., 1 - (embedding <=> $1::vector) AS similarity
  FROM ...
  ORDER BY embedding <=> $1::vector
  LIMIT $4
) ranked
WHERE similarity >= $3;
```

当前实现优先可读性，并且 `ORDER BY` 能直接利用 HNSW 索引。

### 6.2 为什么只查 READY

文档可能处于上传中、解析中或失败状态。只检索 `READY` 可以避免把半成品切片返回给用户。

### 6.3 参数化与维度校验

向量不是直接拼进 SQL，而是：

1. 校验数组长度等于 1536；
2. 校验每个值都是有限数值；
3. 拼成 `[0.1,0.2,...]` 字符串；
4. 作为 SQL 参数传入，再 `::vector` 转换。

即使向量来自外部服务，也不会形成 SQL 注入；维度错误在进入数据库前就会抛出 `INVALID_VECTOR`。

## 七、服务接口

| 方法 | 作用 | 主要校验 |
| --- | --- | --- |
| `createDocumentWithChunks(input)` | 事务写入文档与全部切片 | 切片非空、序号唯一、维度 1536、页码合法 |
| `searchSimilar(input)` | 返回 Top-K 命中 | `topK` 1~50、`minSimilarity` 0~1、`documentId` 非空 |

返回的 `VectorSearchHit` 包含：

- `chunkId` / `documentId` / `documentTitle` / `filename`；
- `content`、`page`、`pageEnd`、`sectionPath`、`blockIndexes`；
- `similarity`（越大越相似）。

这些字段正好够 Week 6 生成「带来源的引用回答」。

## 八、手工验证

数据库可用后，先启动一个带 pgvector 的 PostgreSQL：

```bash
docker run --name ai-lab-pg \
  -e POSTGRES_USER=ai_lab \
  -e POSTGRES_PASSWORD=ai_lab \
  -e POSTGRES_DB=ai_lab \
  -p 5432:5432 \
  -d pgvector/pgvector:pg16
```

把 `DATABASE_URL` 指向它，然后：

```bash
pnpm --filter @ai-lab/api db:migrate
```

插入两条测试切片（用函数生成 1536 维单位向量，避免手写一长串数字）：

```sql
CREATE OR REPLACE FUNCTION test_vector(hot integer)
RETURNS vector AS $$
  SELECT array_agg(
    CASE WHEN i = hot THEN 1.0::real ELSE 0.0::real END
  )::vector
  FROM generate_series(1, 1536) AS i;
$$ LANGUAGE SQL IMMUTABLE;

INSERT INTO "documents" ("id", "title", "filename", "mimeType", "format", "status", "updatedAt")
VALUES ('doc-test', '差旅制度', 'travel.md', 'text/markdown', 'markdown', 'READY', NOW());

INSERT INTO "document_chunks"
  ("id", "documentId", "chunkIndex", "content", "sectionPath", "blockIndexes", "tokenCount", "embedding")
VALUES
  ('chunk-a', 'doc-test', 0, '一线城市住宿六百元', '["差旅制度"]', '[0]', 10, test_vector(1)),
  ('chunk-b', 'doc-test', 1, '二线城市住宿四百元', '["差旅制度"]', '[1]', 10, test_vector(2));

SELECT
  "content",
  1 - ("embedding" <=> test_vector(1)) AS similarity
FROM "document_chunks"
ORDER BY "embedding" <=> test_vector(1)
LIMIT 2;
```

预期 `chunk-a` 的 similarity 为 1，排在第一位。

查看执行计划：

```sql
EXPLAIN ANALYZE
SELECT "id"
FROM "document_chunks"
ORDER BY "embedding" <=> test_vector(1)
LIMIT 5;
```

数据很少时看到 `Seq Scan` 是正常的；插入上千条后再看，或临时 `SET enable_seqscan = off;` 验证索引可用。

## 九、测试

测试文件：[vector-store.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/vector-store.test.cjs)

| 用例 | 验证点 |
| --- | --- |
| 事务写入 | 文档与切片在同一事务，`status`、`metadata` 正确 |
| PENDING 文档 | 允许先建文档、后向量化 |
| 非法输入 | 空切片、重复序号、错误维度、NaN 均不进入事务 |
| 写库异常 | 包装为 `DB_ERROR`，不泄露底层信息 |
| Top-K SQL | 参数化、`ORDER BY`、`LIMIT`、`documentId`/阈值过滤 |
| jsonb 还原 | 字符串形式的 `sectionPath` / `blockIndexes` 正确还原 |
| 检索参数 | `topK`、`minSimilarity`、`documentId` 越界直接失败 |
| 查询异常 | 包装为 `DB_ERROR` |

## 十、验证结果

| 检查 | 结果 |
| --- | --- |
| `prisma validate` | 通过 |
| `prisma generate` | 通过 |
| `prisma migrate diff` | 新增表、索引、外键与迁移 SQL 一致 |
| `@ai-lab/api` 测试 | 70/70 通过（新增 8 项向量库测试） |
| `@ai-lab/rag` 测试 | 36/36 通过 |
| `@ai-lab/ai-core` 测试 | 64/64 通过 |
| 全仓库 lint | 0 error（64 个前端模板 warning） |
| 全仓库 typecheck | 4 个包全部通过 |
| 全仓库 build | 4 个包全部通过 |
| 真实数据库迁移 | 未执行（环境无 Docker / PostgreSQL） |

## 十一、已知限制

- **维度固定 1536**：换 1024 维模型必须改迁移并重建索引，不能原地混用。
- **未在真实 pgvector 上执行**：当前只验证了 schema、SQL 结构与参数；需要按第八节手工跑一次。
- **小表可能不走 HNSW**：顺序扫描在几十条数据时更便宜，属于正常现象。
- **过滤与索引的取舍**：`documentId` 很集中时，PostgreSQL 可能选择先过滤再扫描，HNSW 优势下降；pgvector 0.8 的 iterative scan 可作为后续优化。
- **没有索引参数调优**：HNSW 使用默认 `m` / `ef_construction`，数据量与召回要求变化时需要调。
- **索引只存在于迁移 SQL**：Prisma schema 不表达 `vector_cosine_ops`，`prisma db push` 不会创建 HNSW 索引；本仓库统一用 `db:migrate` / `migrate deploy`，修改索引参数时同步改迁移。
- **逐条 INSERT**：100 个切片就是 100 条 INSERT，虽然在同一事务内，但大批量 ingestion 可以改成多值 INSERT 或 COPY。
- **没有文档版本与去重**：同一文件重复上传会生成新文档；`UNIQUE(documentId, chunkIndex)` 只防同一文档内重复。
- **没有租户隔离**：Week 7 才会加入知识库级权限过滤。
- **JSONB 字段未建索引**：当前不按 `sectionPath` / `blockIndexes` 查询。
- **状态流转未实现**：`PENDING → READY/FAILED` 的异步任务在 Day 6 完成。
- **阈值与浮点误差**：`minSimilarity` 是近似值，边界命中可能因浮点误差抖动。

## 十二、自测题

1. 为什么不能只用内存数组或 JSON 文件保存向量？
2. `<=>` 返回的是相似度还是距离？如何转换成用户看到的 similarity？
3. 为什么几十条数据时 `EXPLAIN` 看不到 HNSW 索引？
4. 为什么 `vector` 列的维度必须固定？换 Embedding 模型要做什么？
5. 为什么文档与切片必须在同一个事务里写入？
6. 为什么向量要作为 SQL 参数传入，而不是直接拼字符串？

### 参考答案

1. 内存/JSON 无法可靠支持持久化、并发写入、按文档过滤、事务与索引；数据量增长后全量循环也无法接受。
2. `<=>` 返回余弦距离，0 表示同向、2 表示反向；对外用 `1 - distance` 得到 similarity，越大越相似。
3. 小表的顺序扫描成本低于索引随机访问，查询规划器会选 Seq Scan；数据量增长或关闭 seqscan 后才能观察索引效果。
4. HNSW 索引与距离计算要求固定维度；换模型必须修改 Prisma schema 与迁移的维度，并重建全部向量和索引，不能在同一列混用。
5. 切片写到一半失败会留下不完整文档，检索结果与引用都不可信；事务保证「要么全部成功，要么全部回滚」。
6. 直接拼接会让外部输入进入 SQL 文本，存在注入风险；参数化后向量只是数据，再通过 `::vector` 转换，同时维度与数值校验能在入库前失败。

## 十三、今日三行

- 今天解决了什么问题：建立 `documents` / `document_chunks` 表与 pgvector HNSW 索引，实现事务写入和按余弦距离排序的 Top-K 检索。
- 为什么这样设计：向量维度与索引必须固定，读写都走原生 SQL；文档与切片同事务，检索只返回 READY，避免半成品进入回答。
- 还有什么不确定：真实数据库上的索引效果、过滤条件对 HNSW 的影响、1536 维是否适合后续语料，需要配置 PostgreSQL 后用真实数据验证。
