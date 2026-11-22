/**
 * 文件作用：知识库 ingestion 与检索编排（Week 5 Day 6）。
 *
 * 一条链路：
 *   上传文件 → 解析 → 切片 → 批量 Embedding → 事务写库 → 返回摘要
 *
 * 查询链路：
 *   问题 → Embedding → pgvector Top-K → 带来源的命中
 *
 * 设计取舍：
 * - 解析、切片、Embedding、存储都通过可替换依赖调用，测试可以完全离线；
 * - 任何一步失败都映射成稳定错误码，不把底层库或供应商文案抛给前端；
 * - 向量维度在写库前再次校验，避免「模型换维度、索引没换」的静默错位。
 */

import { Injectable } from '@nestjs/common';
import {
  DocumentParseError,
  EmbeddingError,
  chunkDocument,
  parseDocument,
  type ParsedDocument,
} from '@ai-lab/rag';
import { AppError } from '../../common/errors/app-error';
import { EmbeddingGateway } from './embedding.gateway';
import { VectorStoreError } from './vector-store.errors';
import { VectorStoreService } from './vector-store.service';
import { VECTOR_DIMENSION, type VectorChunkInput } from './vector-store.types';

export interface IngestDocumentFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface IngestMetrics {
  parseMs: number;
  chunkMs: number;
  embedMs: number;
  storeMs: number;
  totalMs: number;
}

export interface IngestDocumentResult {
  documentId: string;
  title: string;
  filename: string;
  format: ParsedDocument['format'];
  status: 'READY';
  blockCount: number;
  charCount: number;
  chunkCount: number;
  chunkStrategy: string;
  embeddingModel: string;
  dimensions: number;
  usage: { promptTokens: number; totalTokens: number };
  warnings: string[];
  metrics: IngestMetrics;
}

export interface SearchKnowledgeInput {
  query: string;
  topK?: number;
  documentId?: string;
  minSimilarity?: number;
}

export interface SearchKnowledgeResult {
  query: string;
  hits: Awaited<ReturnType<VectorStoreService['searchSimilar']>>;
  meta: {
    embeddingModel: string;
    dimensions: number;
    embeddingMs: number;
    searchMs: number;
    totalMs: number;
    usage: { promptTokens: number; totalTokens: number };
  };
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly store: VectorStoreService,
    private readonly embeddings: EmbeddingGateway,
  ) {}

  async ingest(file: IngestDocumentFile): Promise<IngestDocumentResult> {
    if (!file?.buffer?.length) {
      throw new AppError('文件为空', 'KNOWLEDGE_EMPTY_FILE', 400);
    }

    const startedAt = Date.now();

    const parsed = await this.parse(file);
    const parsedAt = Date.now();

    const chunked = chunkDocument(parsed);
    if (chunked.chunks.length === 0) {
      throw new AppError(
        '文档没有可索引的正文内容',
        'KNOWLEDGE_EMPTY_DOCUMENT',
        400,
      );
    }
    const chunkedAt = Date.now();

    const embedded = await this.embed(chunked.chunks.map((chunk) => chunk.text));
    const embeddedAt = Date.now();

    const vectorByIndex = new Map(
      embedded.items.map((item) => [item.index, item.vector] as const),
    );
    const chunks: VectorChunkInput[] = chunked.chunks.map((chunk) => {
      const vector = vectorByIndex.get(chunk.index);
      if (!vector || vector.length !== VECTOR_DIMENSION) {
        throw new AppError(
          `向量维度与索引配置不一致：期望 ${VECTOR_DIMENSION}，实际 ${vector?.length ?? 0}`,
          'KNOWLEDGE_VECTOR_MISMATCH',
          503,
        );
      }

      return {
        index: chunk.index,
        text: chunk.text,
        page: chunk.page,
        pageEnd: chunk.pageEnd,
        sectionPath: chunk.sectionPath,
        blockIndexes: chunk.blockIndexes,
        tokenCount: chunk.tokenCount,
        embedding: vector,
      };
    });

    const stored = await this.save({
      title: parsed.title,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
      format: parsed.format,
      status: 'READY',
      charCount: parsed.charCount,
      blockCount: parsed.blockCount,
      metadata: {
        ...parsed.metadata,
        ...(parsed.warnings.length || chunked.warnings.length
          ? { warnings: [...parsed.warnings, ...chunked.warnings] }
          : {}),
      },
      chunks,
    });
    const storedAt = Date.now();

    const warnings = [...parsed.warnings, ...chunked.warnings];

    return {
      documentId: stored.documentId,
      title: parsed.title,
      filename: parsed.filename,
      format: parsed.format,
      status: 'READY',
      blockCount: parsed.blockCount,
      charCount: parsed.charCount,
      chunkCount: chunks.length,
      chunkStrategy: chunked.strategy,
      embeddingModel: embedded.model,
      dimensions: embedded.dimensions,
      usage: embedded.usage,
      warnings,
      metrics: {
        parseMs: parsedAt - startedAt,
        chunkMs: chunkedAt - parsedAt,
        embedMs: embeddedAt - chunkedAt,
        storeMs: storedAt - embeddedAt,
        totalMs: storedAt - startedAt,
      },
    };
  }

  async search(input: SearchKnowledgeInput): Promise<SearchKnowledgeResult> {
    const query = input.query?.trim();
    if (!query) {
      throw new AppError('query 不能为空', 'KNOWLEDGE_INVALID_INPUT', 400);
    }
    if (query.length > 500) {
      throw new AppError('query 不能超过 500 个字符', 'KNOWLEDGE_INVALID_INPUT', 400);
    }

    const startedAt = Date.now();
    const embedded = await this.embed([query]);
    const embeddedAt = Date.now();

    const vector = embedded.items[0]?.vector;
    if (!vector || vector.length !== VECTOR_DIMENSION) {
      throw new AppError(
        `向量维度与索引配置不一致：期望 ${VECTOR_DIMENSION}，实际 ${vector?.length ?? 0}`,
        'KNOWLEDGE_VECTOR_MISMATCH',
        503,
      );
    }

    let hits: Awaited<ReturnType<VectorStoreService['searchSimilar']>>;
    try {
      hits = await this.store.searchSimilar({
        embedding: vector,
        topK: input.topK,
        documentId: input.documentId,
        minSimilarity: input.minSimilarity,
      });
    } catch (error) {
      throw toStoreError(error);
    }
    const searchedAt = Date.now();

    return {
      query,
      hits,
      meta: {
        embeddingModel: embedded.model,
        dimensions: embedded.dimensions,
        embeddingMs: embeddedAt - startedAt,
        searchMs: searchedAt - embeddedAt,
        totalMs: searchedAt - startedAt,
        usage: embedded.usage,
      },
    };
  }

  private async parse(file: IngestDocumentFile): Promise<ParsedDocument> {
    try {
      return await parseDocument({
        filename: file.originalname,
        buffer: file.buffer,
        mimeType: file.mimetype,
      });
    } catch (error) {
      if (error instanceof DocumentParseError) {
        if (error.code === 'UNSUPPORTED_FORMAT') {
          throw new AppError(error.message, 'KNOWLEDGE_UNSUPPORTED_FORMAT', 400);
        }
        if (error.code === 'EMPTY_DOCUMENT') {
          throw new AppError(error.message, 'KNOWLEDGE_EMPTY_DOCUMENT', 400);
        }
        throw new AppError('文档解析失败', 'KNOWLEDGE_PARSE_FAILED', 422);
      }
      throw new AppError('文档解析失败', 'KNOWLEDGE_PARSE_FAILED', 500);
    }
  }

  private async embed(texts: string[]): Promise<Awaited<ReturnType<EmbeddingGateway['embed']>>> {
    try {
      return await this.embeddings.embed(texts);
    } catch (error) {
      if (error instanceof EmbeddingError) {
        if (error.code === 'INVALID_CONFIG') {
          throw new AppError(
            'Embedding 服务未配置，请设置 EMBEDDING_API_KEY 等环境变量',
            'KNOWLEDGE_EMBEDDING_UNAVAILABLE',
            503,
          );
        }
        if (error.code === 'INVALID_INPUT') {
          throw new AppError(error.message, 'KNOWLEDGE_EMBEDDING_INPUT_INVALID', 400);
        }
      }
      throw new AppError('Embedding 服务调用失败', 'KNOWLEDGE_EMBEDDING_FAILED', 502);
    }
  }

  private async save(input: Parameters<VectorStoreService['createDocumentWithChunks']>[0]) {
    try {
      return await this.store.createDocumentWithChunks(input);
    } catch (error) {
      throw toStoreError(error);
    }
  }
}

function toStoreError(error: unknown): AppError {
  if (error instanceof VectorStoreError) {
    if (error.code === 'INVALID_INPUT') {
      return new AppError(error.message, 'KNOWLEDGE_INVALID_INPUT', 400);
    }
    if (error.code === 'INVALID_VECTOR') {
      return new AppError('向量维度或数值不合法', 'KNOWLEDGE_VECTOR_MISMATCH', 503);
    }
  }
  return new AppError('向量库暂时不可用', 'KNOWLEDGE_STORE_UNAVAILABLE', 503);
}
