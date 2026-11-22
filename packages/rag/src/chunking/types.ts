/**
 * 文件作用：切片相关的公共类型（Week 5 Day 3）。
 *
 * 切片是解析与向量化之间的桥梁：解析给出「块」，切片决定「送入向量的最小单元」。
 * 每个 chunk 都自带来源信息，检索命中后可以直接生成引用，不需要回查全文。
 */

/** 切片策略：递归字符切片，或按标题分段后再切片。 */
export type ChunkStrategy = 'recursive' | 'markdown';

export interface ChunkOptions {
  /** 默认按文档格式选择：Markdown / DOCX 用 markdown，其它用 recursive。 */
  strategy?: ChunkStrategy;
  /** 单个 chunk 的最大字符数，默认 600。 */
  chunkSize?: number;
  /** 相邻 chunk 的重叠字符数，默认 80；必须小于 chunkSize。 */
  overlap?: number;
}

/** 一个可向量化的文本块。 */
export interface DocumentChunk {
  /** 在本文档中的顺序，从 0 开始。 */
  index: number;
  text: string;
  charCount: number;
  /** 估算 Token 数，用于上下文预算；不是模型分词器的精确值。 */
  tokenCount: number;
  /** 起始页码（PDF）；其它格式为 null。 */
  page: number | null;
  /** 结束页码；跨页 chunk 会与 page 不同。 */
  pageEnd: number | null;
  /** chunk 所属标题路径，取第一个来源块的路径。 */
  sectionPath: string[];
  /** 来源块序号，便于回溯原文。 */
  blockIndexes: number[];
}

export interface ChunkingResult {
  chunks: DocumentChunk[];
  strategy: ChunkStrategy;
  warnings: string[];
}
