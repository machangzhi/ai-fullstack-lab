/**
 * 文件作用：RAG 包的公共出口（Week 5 Day 2）。
 *
 * 目前只包含文档解析；切片（Day 3）、Embedding（Day 4）与检索（Day 5）
 * 会继续在这个包里扩展，API 统一从这里引用。
 */

export { DocumentParseError } from './errors';
export type { DocumentParseErrorCode } from './errors';
export { parseDocument } from './parse-document';
export { chunkDocument } from './chunking/chunk';
export { estimateTokens } from './chunking/tokens';
export type {
  ChunkOptions,
  ChunkStrategy,
  ChunkingResult,
  DocumentChunk,
} from './chunking/types';
export { createEmbeddingClient } from './embedding/client';
export type {
  EmbeddingClient,
  EmbeddingClientOptions,
  EmbeddingResponse,
  EmbeddingUsage,
} from './embedding/client';
export { resolveEmbeddingConfig } from './embedding/config';
export type { EmbeddingConfig } from './embedding/config';
export { embedTexts } from './embedding/embed';
export type {
  BatchStats,
  EmbeddedText,
  EmbedTextsOptions,
  EmbedTextsResult,
} from './embedding/embed';
export { EmbeddingError } from './embedding/errors';
export type { EmbeddingErrorCode } from './embedding/errors';
export { cosineSimilarity } from './embedding/similarity';
export type {
  DocumentFormat,
  ParsedBlock,
  ParsedBlockType,
  ParsedDocument,
  ParseDocumentInput,
} from './types';
