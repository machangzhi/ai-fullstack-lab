/**
 * 文件作用：检索策略的公共类型（Week 6 Day 1）。
 *
 * 为什么把「检索参数」单独建模：
 * - Top-K、阈值、过滤条件、混合模式会反复组合做实验，必须有稳定的数据结构；
 * - 离线对比脚本与在线 API 共用同一套语义，避免「实验里有效、线上参数不同」；
 * - 候选片段（candidate）先由向量库或关键词检索产出，再由这里统一排序，
 *   这样对比实验不需要连接数据库或消耗 Embedding 费用。
 */

/** 检索模式：纯向量、纯关键词、混合。 */
export type RetrievalMode = 'vector' | 'keyword' | 'hybrid';

/** 混合检索的融合方式：加权求和，或 Reciprocal Rank Fusion。 */
export type HybridFusion = 'weighted' | 'rrf';

/**
 * 过滤条件，全部是「硬约束」：不满足的片段直接排除，不参与打分。
 *
 * 注意与相似度阈值的区别：
 * - 阈值是「软约束」，分数低于阈值才排除；
 * - 过滤是「硬约束」，例如只看 PDF 或只看某个章节，分数再高也不返回。
 */
export interface RetrievalFilters {
  /** 只检索这些文档 ID。 */
  documentIds?: string[];
  /** 只检索这些格式：pdf / docx / txt / markdown。 */
  formats?: string[];
  /** 文件名包含该子串（不区分大小写）。 */
  filenameContains?: string;
  /** 文档标题包含该子串（不区分大小写）。 */
  titleContains?: string;
  /** 章节路径前缀，例如 ["差旅制度", "住宿标准"]。 */
  sectionPathPrefix?: string[];
}

/**
 * 一条待排序的候选片段。
 *
 * `similarity` 通常来自向量库（1 - 余弦距离）；离线实验也可以直接注入。
 * 关键词分数不在这里预计算，因为同一个片段会被多个查询复用。
 */
export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  filename: string;
  /** 文档格式；未知时为 null，此时格式过滤会把它排除。 */
  format?: string | null;
  content: string;
  sectionPath?: string[];
  page?: number | null;
  /** 余弦相似度，约定 0~1。 */
  similarity: number;
}

/** 检索参数。所有字段都可选，默认值在 searchCandidates 中集中说明。 */
export interface RetrievalOptions {
  /** 返回条数，默认 5，范围 1~50。 */
  topK?: number;
  /** 最低余弦相似度，默认 0（不过滤），范围 0~1。 */
  minSimilarity?: number;
  filters?: RetrievalFilters;
  /** 默认 vector。 */
  mode?: RetrievalMode;
  /** 混合模式默认 weighted。 */
  fusion?: HybridFusion;
  /** 加权融合中向量分数的权重，默认 0.7，范围 0~1。 */
  vectorWeight?: number;
  /** RRF 的平滑常数，默认 60；越小越强调头部名次。 */
  rrfK?: number;
}

/** 检索命中，比候选多出关键词分数、最终分数与名次。 */
export interface RetrievalHit extends RetrievalCandidate {
  /** 关键词覆盖率，0~1。 */
  keywordScore: number;
  /** 最终排序分数；vector 模式下等于 similarity。 */
  score: number;
  /** 从 1 开始的名次。 */
  rank: number;
}

/** 一组查询及其候选集，用于离线对比。 */
export interface RetrievalQueryCandidates {
  query: string;
  candidates: RetrievalCandidate[];
}

/** 一个待对比的检索配置。 */
export interface RetrievalConfig {
  name: string;
  options: RetrievalOptions;
}

/** 单个查询在某个配置下的结果摘要。 */
export interface RetrievalQueryResult {
  query: string;
  hitCount: number;
  top1ChunkId: string | null;
  top1Similarity: number | null;
  top1Score: number | null;
  chunkIds: string[];
}

/** 单个配置的汇总指标。 */
export interface RetrievalConfigComparison {
  name: string;
  mode: RetrievalMode;
  topK: number;
  minSimilarity: number;
  queryCount: number;
  queriesWithHits: number;
  hitRate: number;
  totalHits: number;
  avgHitsPerQuery: number;
  avgTop1Similarity: number | null;
  avgTop1Score: number | null;
  /** 与基线配置的平均 Jaccard 重合度，0~1。 */
  baselineOverlap: number;
  /** Top-1 片段与基线一致的比例，0~1。 */
  top1SameRate: number;
  perQuery: RetrievalQueryResult[];
}

/** 对比报告：第一个配置作为基线。 */
export interface RetrievalComparisonReport {
  baseline: string;
  configs: RetrievalConfigComparison[];
}
