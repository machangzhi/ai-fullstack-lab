# Week 6 Day 1：检索策略

> 目标：在 Week 5 已有 Top-K 检索的基础上，理解并实现相似度阈值、Metadata Filter 与混合检索，并用固定候选集比较不同 K 值与阈值的效果。
>
> 产物：`packages/rag` 检索策略模块、`/api/knowledge/search` 过滤条件、离线对比脚本与报告、16 项新增测试。

## 一、为什么「能检索」不等于「检索得好」

Week 5 已经能完成「问题 → 向量 → Top-K 片段」的闭环，但只有 K 一个参数时，系统无法回答下面这些问题：

| 问题 | 后果 | 今天的对策 |
| --- | --- | --- |
| K 取多少合适？ | 太大把噪声塞进上下文，太小漏掉答案 | 固定候选集上比较 K=1/3/5/10 |
| 相似度 0.3 的片段要不要？ | 低分片段会污染 Prompt | 增加 `minSimilarity` 阈值 |
| 用户只想问某一个文档/章节 | 无关但语义相似的片段抢占 Top-K | Metadata Filter，先过滤再排序 |
| 专有名词、编号、精确短语搜不到 | 向量只擅长语义泛化 | 混合检索：关键词 + 向量 |

检索策略本质上是**在召回率、精度、上下文预算之间做取舍**。今天把四个旋钮都做成可配置、可对比的。

## 二、Top-K：名额怎么分

`topK` 决定最终交给模型的片段数量。

- K 越大，召回率通常越高，但上下文越长、噪声越多、成本越高；
- K 越小，上下文越干净，但答案可能落在第 6 条而没被取到；
- 阈值过滤后不足 K 条时**不补位**：宁缺毋滥，不能用低分片段凑数。

本项目的默认值是 `K = 5`，范围限制为 1~50（API 层限制 1~20）。实际值应由评测集决定，而不是凭感觉。

## 三、相似度阈值：什么时候该拒绝

pgvector 的 `<=>` 返回余弦距离，`similarity = 1 - distance`，范围 0~1：

- 1 表示方向完全一致；
- 0 表示无关或正交；
- 负数在文本 Embedding 中很少见，本项目的阈值参数限制在 0~1。

阈值的作用是**过滤低质量命中**，但有两个容易忽略的点：

1. **分数分布依赖模型**：`text-embedding-3-small` 的 0.5 与另一个模型的 0.5 不是一回事，换模型必须重新校准；
2. **阈值不是正确率**：相似只代表「语义接近」，不代表「能回答问题」。阈值过高会让本可回答的问题变成零命中。

零命中的处理属于 Day 2 的 RAG Prompt：资料不足时应明确拒答，而不是让模型自由发挥。

## 四、Metadata Filter：硬约束

过滤与阈值的区别：

| 维度 | 阈值 | 过滤 |
| --- | --- | --- |
| 性质 | 软约束，按分数排除 | 硬约束，按范围排除 |
| 典型条件 | `similarity >= 0.5` | 文档、格式、章节、metadata |
| 作用 | 去噪 | 限定业务范围、权限、租户 |

今天在 `/api/knowledge/search` 增加 `filters`，支持：

| 字段 | 说明 | SQL 实现 |
| --- | --- | --- |
| `documentIds` | 指定文档 ID，最多 20 个 | `d."id" IN (...)` |
| `formats` | `pdf` / `docx` / `txt` / `markdown` | `d."format" IN (...)` |
| `filenameContains` | 文件名包含子串 | `ILIKE '%...%' ESCAPE '\'` |
| `titleContains` | 标题包含子串 | `ILIKE '%...%' ESCAPE '\'` |
| `sectionPathPrefix` | 章节路径前缀，按顺序逐层匹配 | `sectionPath->>0 = ... AND sectionPath->>1 = ...` |
| `metadata` | 文档 metadata 精确匹配 | `d."metadata" @> '{"key":"value"}'::jsonb` |

三个实现细节：

1. **先过滤再排序**：Top-K 是名额，不是候选池。先排序后过滤会让无关文档占掉名额，最终条数远小于 K。
2. **章节前缀不能用 `@>`**：JSONB 数组的包含判断不关心顺序，而 `["住宿标准","差旅制度"]` 与 `["差旅制度","住宿标准"]` 是不同路径。这里逐层比较 `->>N`。
3. **LIKE 通配符要转义**：用户输入的 `%` 与 `_` 必须转义，否则「文件名包含」会变成范围过大的模糊查询。

实现位置：[vector-store.sql.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/vector-store.sql.ts)、[search-knowledge.dto.ts](file:///d:/StudyAI/ai-fullstack-lab/apps/api/src/modules/knowledge/dto/search-knowledge.dto.ts)

## 五、混合检索：概念与离线原型

纯向量检索的盲区：

- 具体编号、合同号、错误码；
- 专有名词、缩写、新词；
- 精确短语，例如「发票抬头」与「抬头发票」。

纯关键词检索的盲区：

- 同义词与改写：「报销期限」 vs 「多久内提交」；
- 语义泛化：「住宿标准」 vs 「酒店多少钱」。

混合检索把两路候选融合，常见两种做法：

### 5.1 加权求和

```text
score = w × similarity + (1 - w) × keywordScore
```

优点是分数可解释；缺点是要把两种分数归一化到同一量纲，权重要调。

### 5.2 Reciprocal Rank Fusion（RRF）

```text
score = w / (k + rankVector) + (1 - w) / (k + rankKeyword)
```

只看名次，不看原始分数，因此不需要归一化；代价是无法区分「第一名比第二名好多少」。本项目默认 `k = 60`。

离线原型在 [search.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/search.ts)，关键词打分采用「中文二元组 + 英文词」的覆盖率，见 [keyword.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/keyword.ts)。

生产环境不建议用覆盖率硬扛：中文应使用 PostgreSQL 全文索引（`zhparser` / `pg_jieba`）、Elasticsearch 或 OpenSearch 的 BM25，再与向量结果融合。今天的离线实现用于验证融合流程与参数影响，不承担线上检索职责。

## 六、实现结构

### 6.1 离线检索策略模块

| 文件 | 职责 |
| --- | --- |
| [types.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/types.ts) | 过滤条件、候选片段、检索参数、对比报告类型 |
| [filters.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/filters.ts) | 与 API 语义一致的硬过滤 |
| [keyword.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/keyword.ts) | 中文二元组、英文词与覆盖率打分 |
| [search.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/search.ts) | vector / keyword / hybrid 三种模式与 RRF |
| [compare.ts](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/src/retrieval/compare.ts) | 多配置对比：命中率、平均命中数、重合度、Top-1 一致率 |

统一的处理顺序：

```text
候选集
  → Metadata Filter（硬约束）
  → 关键词打分
  → 按模式打分（vector / keyword / hybrid）
  → 相似度阈值（只作用于向量分数）
  → 排序、截断 Top-K、附上 rank
```

为什么阈值只作用于向量分数：相似度有明确的 0~1 语义，而关键词覆盖率与 RRF 分数的量纲不同。把同一个阈值套到最终分数上，会让不同模式下的参数不可比。

### 6.2 API 检索参数

请求示例：

```json
{
  "query": "一线城市住宿标准是多少？",
  "topK": 5,
  "minSimilarity": 0.4,
  "filters": {
    "formats": ["markdown"],
    "titleContains": "差旅",
    "sectionPathPrefix": ["差旅管理制度", "住宿标准"],
    "metadata": { "source": "parser" }
  }
}
```

返回的每条命中新增 `format` 字段，便于前端展示与排查过滤条件。`documentId` 仍然保留，等价于 `filters.documentIds` 的单值快捷方式。

### 6.3 如何用真实数据做对比

对比脚本读取「查询 + 候选片段 + similarity」：

```bash
pnpm --filter @ai-lab/rag compare:retrieval
```

数据集默认是 [retrieval-candidates.json](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/evals/datasets/retrieval-candidates.json)。接上真实数据库后，把 `/api/knowledge/search` 返回的查询与命中导出成同样结构，再用 `--input` 指向该文件即可复用同一套指标：

```bash
pnpm --filter @ai-lab/rag compare:retrieval -- --input evals/datasets/retrieval-real.json
```

报告默认写入 `packages/rag/reports/retrieval-strategy.md`（本地调试产物，已在 `.gitignore` 中忽略）。

## 七、对比结果

数据集：4 个虚构制度文档、19 个切片、8 条查询。**similarity 为模拟分数，仅用于验证对比流程，不代表真实语义效果。**

基线：`K=5 / T=0`。

### 7.1 Top-K × 阈值

| 配置 | K | 阈值 | 平均命中数 | 有命中查询 | 平均 Top-1 相似度 | 与基线重合度 | Top-1 一致率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| K=1 / T=0 | 1 | 0 | 1.00 | 8/8 | 0.881 | 20% | 100% |
| K=1 / T=0.3 | 1 | 0.3 | 1.00 | 8/8 | 0.881 | 20% | 100% |
| K=1 / T=0.5 | 1 | 0.5 | 1.00 | 8/8 | 0.881 | 20% | 100% |
| K=1 / T=0.7 | 1 | 0.7 | 1.00 | 8/8 | 0.881 | 20% | 100% |
| K=1 / T=0.85 | 1 | 0.85 | 0.88 | 7/8 | 0.887 | 18% | 88% |
| K=3 / T=0 | 3 | 0 | 3.00 | 8/8 | 0.881 | 60% | 100% |
| K=3 / T=0.3 | 3 | 0.3 | 3.00 | 8/8 | 0.881 | 60% | 100% |
| K=3 / T=0.5 | 3 | 0.5 | 2.50 | 8/8 | 0.881 | 50% | 100% |
| K=3 / T=0.7 | 3 | 0.7 | 1.38 | 8/8 | 0.881 | 27% | 100% |
| K=3 / T=0.85 | 3 | 0.85 | 0.88 | 7/8 | 0.887 | 18% | 88% |
| K=5 / T=0 | 5 | 0 | 5.00 | 8/8 | 0.881 | 100% | 100% |
| K=5 / T=0.3 | 5 | 0.3 | 4.63 | 8/8 | 0.881 | 93% | 100% |
| K=5 / T=0.5 | 5 | 0.5 | 2.75 | 8/8 | 0.881 | 55% | 100% |
| K=5 / T=0.7 | 5 | 0.7 | 1.38 | 8/8 | 0.881 | 27% | 100% |
| K=5 / T=0.85 | 5 | 0.85 | 0.88 | 7/8 | 0.887 | 18% | 88% |
| K=10 / T=0 | 10 | 0 | 6.75 | 8/8 | 0.881 | 75% | 100% |
| K=10 / T=0.3 | 10 | 0.3 | 4.63 | 8/8 | 0.881 | 93% | 100% |
| K=10 / T=0.5 | 10 | 0.5 | 2.75 | 8/8 | 0.881 | 55% | 100% |
| K=10 / T=0.7 | 10 | 0.7 | 1.38 | 8/8 | 0.881 | 27% | 100% |
| K=10 / T=0.85 | 10 | 0.85 | 0.88 | 7/8 | 0.887 | 18% | 88% |

### 7.2 检索模式对比

| 配置 | 模式 | 平均命中数 | 有命中查询 | 与基线重合度 | Top-1 一致率 |
| --- | --- | --- | --- | --- | --- |
| vector / K=5 / T=0.3 | vector | 4.63 | 8/8 | 93% | 100% |
| keyword / K=5 | keyword | 3.25 | 8/8 | 58% | 100% |
| hybrid-weighted / 0.7 | hybrid | 4.63 | 8/8 | 93% | 100% |
| hybrid-rrf / 0.7 | hybrid | 4.75 | 8/8 | 91% | 100% |

### 7.3 过滤条件对比

查询：`一线城市住宿标准是多少？`，K=5，阈值=0.3。

| 过滤条件 | 命中数 | Top-1 片段 | Top-1 相似度 |
| --- | --- | --- | --- |
| 无过滤 | 5 | t-01（差旅管理制度） | 0.910 |
| 章节前缀 ["差旅管理制度", "住宿标准"] | 2 | t-01（差旅管理制度） | 0.910 |
| 格式 = pdf | 0 | — | — |
| 文档 = doc-hr（考勤与休假制度） | 0 | — | — |

### 7.4 结论

1. **K 改变的是尾部，不是头部**：K 从 1 增到 10，Top-1 一致率始终 100%，平均命中数从 1.00 增到 6.75。增大 K 主要增加上下文噪声，不会自动提升答案质量。
2. **阈值是主要闸门**：K=5 时，阈值从 0 提到 0.7，平均命中数从 5.00 降到 1.38；阈值 0.85 时出现 1 条查询零命中。
3. **K 与阈值存在等效区间**：K=10/T=0.3 与 K=5/T=0.3 的平均命中数同为 4.63，说明候选池本身有限时，继续增大 K 没有收益。
4. **关键词召回更保守**：keyword 模式平均命中 3.25，与向量结果重合度 58%，说明两路召回的差异明显，适合融合而不是互相替代。
5. **过滤是范围工具，不是质量工具**：把格式限定为 pdf 后，差旅问题直接零命中；过滤条件必须由业务语义决定，不能用来「提高相关性」。

以上结论只针对当前合成分数。真实效果需要 Day 5 的 30 条问答基准集与 Recall@K 指标。

## 八、测试

新增测试：

| 测试文件 | 覆盖点 |
| --- | --- |
| [retrieval.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/packages/rag/tests/retrieval.test.cjs) | 过滤条件、关键词打分、Top-K/阈值、加权与 RRF、参数校验、配置对比 |
| [vector-store.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/vector-store.test.cjs) | 过滤条件参数化 SQL、非法过滤参数、`format` 字段映射 |
| [knowledge.test.cjs](file:///d:/StudyAI/ai-fullstack-lab/apps/api/tests/knowledge.test.cjs) | 过滤条件透传、嵌套 DTO 校验 |

验证结果：

| 检查 | 结果 |
| --- | --- |
| `@ai-lab/rag` 测试 | 49/49 通过（新增 13 项） |
| `@ai-lab/api` 测试 | 81/81 通过（新增 3 项） |
| `@ai-lab/api` lint | 通过 |
| 全仓库 typecheck | 4 个包全部通过 |
| 全仓库 build | 4 个包全部通过 |
| 对比脚本 | 成功生成 `reports/retrieval-strategy.md` |
| 真实 pgvector 执行 | 未执行（当前环境无 PostgreSQL） |

## 九、已知限制

- **数据集是合成的**：similarity 由人工设定，只能验证比较流程，不能作为检索质量结论。
- **没有真实 Recall@K**：当前数据集没有「标准答案片段」标注，Day 5 会建立 30 条问答基准集并计算命中率与 Recall@K。
- **关键词打分不是 BM25**：覆盖率不处理词频饱和、同义词与停用词；生产环境应换 PostgreSQL 全文索引或 Elasticsearch。
- **混合检索未接入在线 API**：离线原型已验证融合逻辑，在线链路仍是向量检索 + 过滤；Day 3 接入 Retriever，Day 4 再做 query rewrite 与 rerank。
- **JSONB 过滤未建索引**：`metadata @>` 与 `sectionPath->>N` 在数据量上来后会变慢，需要 GIN 索引或表达式索引。
- **ILIKE 全模糊匹配**：`%...%` 无法使用普通 B-tree 索引；大表应改用 pg_trgm 或全文检索。
- **阈值未按模型校准**：换 Embedding 模型后必须重新跑评测集确定阈值。
- **过滤条件上限是经验值**：文档 ID 最多 20 个，章节前缀最多 10 层；更大范围应改用知识库/租户 ID，而不是超长数组。
- **真实数据库验证缺失**：SQL 结构与参数由 Fake Prisma 测试，尚未在 pgvector 上执行。

## 十、自测题

1. 为什么 K 增大不一定让答案更好？
2. 阈值过滤后不足 K 条时，为什么不应该用低分片段补位？
3. Metadata Filter 与相似度阈值的本质区别是什么？
4. 为什么章节路径前缀过滤不能直接用 JSONB 的 `@>`？
5. 混合检索中加权求和与 RRF 各有什么优缺点？
6. 为什么 RRF 不需要把余弦相似度和关键词分数归一化？

### 参考答案

1. 增大 K 只是把更多低相似度片段放进上下文；新增内容通常是尾部噪声，会增加 Token 成本和干扰，Top-1 往往不变，答案质量不会自动提升。
2. Top-K 是上限而不是配额。低分片段代表证据不足，补位会让模型基于无关内容作答，破坏引用可信度；应返回更少片段并触发拒答或澄清。
3. 阈值按分数排除，是软约束；过滤按业务范围排除，是硬约束。过滤条件不满足时，即使相似度再高也不会返回。
4. `@>` 只判断数组是否包含元素，不关心顺序；章节路径是层级结构，必须逐层比较 `->>0`、`->>1` 才能表达「以该路径开头」。
5. 加权求和高可解释、可调权重，但需要归一化且对量纲敏感；RRF 只看名次、无需归一化、更稳健，但丢失分数差距信息。
6. RRF 使用的是每个候选在各自列表中的名次，而不是原始分数；名次天然在同一尺度上，所以不需要归一化。

## 十一、今日三行

- 今天解决了什么问题：把检索从「只有 Top-K」扩展为 Top-K + 阈值 + Metadata Filter，并实现关键词/混合检索的离线原型与 K×阈值对比脚本。
- 为什么这样设计：过滤前置保证名额不被无关文档占用；阈值只作用于向量分数，避免不同模式的量纲混用；对比指标聚焦命中数、重合度与 Top-1 稳定性，而不是单一分数。
- 还有什么不确定：真实数据上的阈值应取多少、混合检索的权重如何校准、JSONB/ILIKE 过滤在数据量增长后的性能，需要在配置好数据库后用 Day 5 的评测集验证。
