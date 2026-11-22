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
}

export interface VectorSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  filename: string;
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
