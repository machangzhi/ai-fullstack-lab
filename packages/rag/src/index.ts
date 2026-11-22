/**
 * 文件作用：RAG 包的公共出口（Week 5 Day 2 起，Week 6 Day 1 扩展检索策略）。
 *
 * 目前包含：文档解析、切片、Embedding、检索策略。
 * 向量库与 API 编排在 apps/api，离线实验与纯函数留在这个包里。
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
export { compareRetrievalConfigs } from './retrieval/compare';
export { RetrievalError } from './retrieval/errors';
export type { RetrievalErrorCode } from './retrieval/errors';
export { matchesRetrievalFilters } from './retrieval/filters';
export { keywordScore, tokenizeForKeyword } from './retrieval/keyword';
export { searchCandidates } from './retrieval/search';
export type {
  HybridFusion,
  RetrievalCandidate,
  RetrievalComparisonReport,
  RetrievalConfig,
  RetrievalConfigComparison,
  RetrievalFilters,
  RetrievalHit,
  RetrievalMode,
  RetrievalOptions,
  RetrievalQueryCandidates,
  RetrievalQueryResult,
} from './retrieval/types';
export type {
  DocumentFormat,
  ParsedBlock,
  ParsedBlockType,
  ParsedDocument,
  ParseDocumentInput,
} from './types';
