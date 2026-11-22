/**
 * 文件作用：向量库的输入输出契约（Week 5 Day 5）。
 *
 * 这些类型描述「应用层如何访问向量库」，不暴露 Prisma 或 SQL 细节。
 * 后续 RAG 问答、异步 ingestion 都依赖这份契约。
 */

/**
 * 向量维度，必须与迁移中的 vector(1536) 一致。
 *
 * 为什么写死：pgvector 的列类型和 HNSW 索引都需要固定维度。
 * 换 1024 维模型（如 bge-m3）时，必须改迁移、重建索引，
 * 不能在同一张表里混用不同维度。
 */
export const VECTOR_DIMENSION = 1536;

export type VectorDocumentStatus = 'PENDING' | 'READY' | 'FAILED';

/** 可检索的文档格式，与解析器支持的格式一致。 */
export const SEARCHABLE_DOCUMENT_FORMATS = ['pdf', 'docx', 'txt', 'markdown'] as const;

/**
 * 检索过滤条件（Week 6 Day 1）。
 *
 * 全部是硬约束：不满足的切片直接不进入排序。
 * 与 minSimilarity 的区别：阈值是「分数不够才排除」，过滤是「范围不对就排除」。
 */
export interface VectorSearchFilters {
  /** 只检索这些文档 ID，最多 20 个。 */
  documentIds?: string[];
  /** 只检索这些格式：pdf / docx / txt / markdown。 */
  formats?: string[];
  /** 文件名包含该子串（不区分大小写）。 */
  filenameContains?: string;
  /** 文档标题包含该子串（不区分大小写）。 */
  titleContains?: string;
  /** 章节路径前缀，例如 ["差旅制度", "住宿标准"]。 */
  sectionPathPrefix?: string[];
  /** 文档 metadata 的精确匹配（JSONB 包含关系），例如 { source: "pdf-info" }。 */
  metadata?: Record<string, string | number | boolean>;
}

export interface VectorChunkInput {
  /** 文档内顺序，从 0 开始，必须唯一。 */
  index: number;
  text: string;
  page: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  blockIndexes: number[];
  tokenCount: number;
  /** 长度必须等于 VECTOR_DIMENSION。 */
  embedding: number[];
}

export interface CreateVectorDocumentInput {
  title: string;
  filename: string;
  mimeType: string;
  format: string;
  status?: VectorDocumentStatus;
  charCount: number;
  blockCount: number;
  metadata?: Record<string, unknown>;
  chunks: VectorChunkInput[];
}

export interface CreateVectorDocumentResult {
  documentId: string;
  chunkCount: number;
}

export interface SearchSimilarInput {
  embedding: number[];
  /** 返回条数，默认 5，范围 1~50。 */
  topK?: number;
  /** 只检索指定文档；不传表示整个知识库。 */
  documentId?: string;
  /** 最低余弦相似度，范围 0~1；不传表示不过滤。 */
  minSimilarity?: number;
  /** 文档/章节/元数据过滤条件（Week 6 Day 1）。 */
  filters?: VectorSearchFilters;
}

export interface VectorSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  filename: string;
  /** 文档格式，便于前端展示与调试过滤条件。 */
  format: string;
  chunkIndex: number;
  content: string;
  page: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  blockIndexes: number[];
  tokenCount: number;
  /** 余弦相似度，1 表示方向完全一致。 */
  similarity: number;
}
