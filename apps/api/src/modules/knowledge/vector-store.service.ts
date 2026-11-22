/**
 * 文件作用：向量库读写服务（Week 5 Day 5）。
 *
 * 三个关键点：
 * 1. 文档与切片在同一个事务里写入，切片失败不会留下「空文档」；
 * 2. 向量由 pgvector 存储，写入与检索都走原生 SQL；
 * 3. 检索只返回 READY 文档，并按余弦距离升序取 Top-K。
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DocumentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VectorStoreError } from './vector-store.errors';
import {
  buildSearchSql,
  normalizeNumberArray,
  normalizeStringArray,
  toVectorLiteral,
} from './vector-store.sql';
import type {
  CreateVectorDocumentInput,
  CreateVectorDocumentResult,
  SearchSimilarInput,
  VectorChunkInput,
  VectorSearchFilters,
  VectorSearchHit,
} from './vector-store.types';
import { SEARCHABLE_DOCUMENT_FORMATS } from './vector-store.types';

interface RawSearchRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  filename: string;
  format: string;
  chunkIndex: number;
  content: string;
  page: number | null;
  pageEnd: number | null;
  sectionPath: unknown;
  blockIndexes: unknown;
  tokenCount: number;
  similarity: number | string;
}

@Injectable()
export class VectorStoreService {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建文档并写入全部切片；任一切片失败会回滚整个事务。 */
  async createDocumentWithChunks(
    input: CreateVectorDocumentInput,
  ): Promise<CreateVectorDocumentResult> {
    validateCreateInput(input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const document = await tx.document.create({
          data: {
            title: input.title.trim(),
            filename: input.filename.trim(),
            mimeType: input.mimeType.trim(),
            format: input.format.trim(),
            status: (input.status ?? 'READY') as DocumentStatus,
            charCount: input.charCount,
            blockCount: input.blockCount,
            ...(input.metadata !== undefined
              ? { metadata: input.metadata as Prisma.InputJsonValue }
              : {}),
          },
        });

        for (const chunk of input.chunks) {
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "document_chunks" (
              "id",
              "documentId",
              "chunkIndex",
              "content",
              "page",
              "pageEnd",
              "sectionPath",
              "blockIndexes",
              "tokenCount",
              "embedding"
            ) VALUES (
              ${randomUUID()},
              ${document.id},
              ${chunk.index},
              ${chunk.text},
              ${chunk.page},
              ${chunk.pageEnd},
              ${JSON.stringify(chunk.sectionPath)}::jsonb,
              ${JSON.stringify(chunk.blockIndexes)}::jsonb,
              ${chunk.tokenCount},
              ${toVectorLiteral(chunk.embedding)}::vector
            )
          `);
        }

        return { documentId: document.id, chunkCount: input.chunks.length };
      });
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError('DB_ERROR', '写入向量库失败', error);
    }
  }

  /**
   * 按余弦相似度检索 Top-K。
   *
   * pgvector 的 `<=>` 返回余弦距离：0 表示同向，2 表示反向。
   * 对外返回 similarity = 1 - distance，更符合「越大越相似」的直觉。
   */
  async searchSimilar(input: SearchSimilarInput): Promise<VectorSearchHit[]> {
    const vectorLiteral = toVectorLiteral(input.embedding);
    const topK = validateSearchInput(input);
    validateSearchFilters(input.filters);
    const documentId = input.documentId?.trim();

    const sql = buildSearchSql({
      vectorLiteral,
      topK,
      documentId,
      minSimilarity: input.minSimilarity,
      filters: normalizeFilters(input.filters),
    });

    let rows: RawSearchRow[];
    try {
      rows = await this.prisma.$queryRaw<RawSearchRow[]>(sql);
    } catch (error) {
      throw new VectorStoreError('DB_ERROR', '向量检索失败', error);
    }

    return rows.map(mapSearchRow);
  }
}

function validateCreateInput(input: CreateVectorDocumentInput): void {
  assertNonEmptyString(input.title, 'title');
  assertNonEmptyString(input.filename, 'filename');
  assertNonEmptyString(input.mimeType, 'mimeType');
  assertNonEmptyString(input.format, 'format');

  if (!Number.isInteger(input.charCount) || input.charCount < 0) {
    throw new VectorStoreError('INVALID_INPUT', 'charCount 必须是非负整数');
  }
  if (!Number.isInteger(input.blockCount) || input.blockCount < 0) {
    throw new VectorStoreError('INVALID_INPUT', 'blockCount 必须是非负整数');
  }
  if (
    input.status !== undefined &&
    !['PENDING', 'READY', 'FAILED'].includes(input.status)
  ) {
    throw new VectorStoreError('INVALID_INPUT', `未知文档状态：${input.status}`);
  }
  if (
    input.metadata !== undefined &&
    (typeof input.metadata !== 'object' ||
      input.metadata === null ||
      Array.isArray(input.metadata))
  ) {
    throw new VectorStoreError('INVALID_INPUT', 'metadata 必须是对象');
  }
  if (!Array.isArray(input.chunks) || input.chunks.length === 0) {
    throw new VectorStoreError('INVALID_INPUT', '至少需要一个切片');
  }

  const indexes = new Set<number>();
  input.chunks.forEach((chunk, position) => {
    validateChunk(chunk, position);
    if (indexes.has(chunk.index)) {
      throw new VectorStoreError('INVALID_INPUT', `切片序号重复：${chunk.index}`);
    }
    indexes.add(chunk.index);
  });
}

function validateChunk(chunk: VectorChunkInput, position: number): void {
  if (!Number.isInteger(chunk.index) || chunk.index < 0) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 index 非法`);
  }
  if (typeof chunk.text !== 'string' || !chunk.text.trim()) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片文本为空`);
  }
  if (chunk.page !== null && (!Number.isInteger(chunk.page) || chunk.page < 1)) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 page 非法`);
  }
  if (chunk.pageEnd !== null && (!Number.isInteger(chunk.pageEnd) || chunk.pageEnd < 1)) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 pageEnd 非法`);
  }
  if (chunk.page !== null && chunk.pageEnd !== null && chunk.pageEnd < chunk.page) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 pageEnd 小于 page`);
  }
  if (
    !Array.isArray(chunk.sectionPath) ||
    chunk.sectionPath.some((item) => typeof item !== 'string')
  ) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 sectionPath 非法`);
  }
  if (
    !Array.isArray(chunk.blockIndexes) ||
    chunk.blockIndexes.some((item) => !Number.isInteger(item) || item < 0)
  ) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 blockIndexes 非法`);
  }
  if (!Number.isInteger(chunk.tokenCount) || chunk.tokenCount < 0) {
    throw new VectorStoreError('INVALID_INPUT', `第 ${position} 个切片 tokenCount 非法`);
  }

  // 维度与数值校验在这里完成，避免把坏向量带进数据库。
  toVectorLiteral(chunk.embedding);
}

function validateSearchInput(input: SearchSimilarInput): number {
  const topK = input.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    throw new VectorStoreError('INVALID_INPUT', 'topK 必须是 1~50 的整数');
  }
  if (
    input.documentId !== undefined &&
    (typeof input.documentId !== 'string' || !input.documentId.trim())
  ) {
    throw new VectorStoreError('INVALID_INPUT', 'documentId 必须是非空字符串');
  }
  if (
    input.minSimilarity !== undefined &&
    (typeof input.minSimilarity !== 'number' ||
      !Number.isFinite(input.minSimilarity) ||
      input.minSimilarity < 0 ||
      input.minSimilarity > 1)
  ) {
    throw new VectorStoreError('INVALID_INPUT', 'minSimilarity 必须是 0~1 之间的数值');
  }

  return topK;
}

/**
 * 过滤条件来自用户输入，必须在进入 SQL 前完成范围与类型校验。
 * 这里不使用 class-validator：Service 也可能被其他模块直接调用。
 */
function validateSearchFilters(filters?: VectorSearchFilters): void {
  if (filters === undefined) return;
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw new VectorStoreError('INVALID_INPUT', 'filters 必须是对象');
  }

  assertOptionalStringArray(filters.documentIds, 'filters.documentIds', 20, 64);
  assertOptionalStringArray(filters.formats, 'filters.formats', 10, 32);
  if (filters.formats) {
    const unknown = filters.formats.filter(
      (format) =>
        !(SEARCHABLE_DOCUMENT_FORMATS as readonly string[]).includes(
          format.trim().toLowerCase(),
        ),
    );
    if (unknown.length > 0) {
      throw new VectorStoreError(
        'INVALID_INPUT',
        `不支持的文档格式：${unknown.join(', ')}`,
      );
    }
  }

  assertOptionalText(filters.filenameContains, 'filters.filenameContains', 100);
  assertOptionalText(filters.titleContains, 'filters.titleContains', 100);
  assertOptionalStringArray(filters.sectionPathPrefix, 'filters.sectionPathPrefix', 10, 100);

  if (filters.metadata !== undefined) {
    if (
      typeof filters.metadata !== 'object' ||
      filters.metadata === null ||
      Array.isArray(filters.metadata)
    ) {
      throw new VectorStoreError('INVALID_INPUT', 'filters.metadata 必须是对象');
    }

    const entries = Object.entries(filters.metadata);
    if (entries.length === 0) {
      throw new VectorStoreError('INVALID_INPUT', 'filters.metadata 不能为空对象');
    }
    if (entries.length > 20) {
      throw new VectorStoreError('INVALID_INPUT', 'filters.metadata 最多 20 个键');
    }

    for (const [key, value] of entries) {
      if (!key.trim() || key.length > 64) {
        throw new VectorStoreError('INVALID_INPUT', 'filters.metadata 的键必须是 1~64 字符');
      }
      if (typeof value === 'string') {
        if (!value.trim() || value.length > 200) {
          throw new VectorStoreError(
            'INVALID_INPUT',
            `filters.metadata.${key} 必须是 1~200 字符的字符串`,
          );
        }
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new VectorStoreError('INVALID_INPUT', `filters.metadata.${key} 必须是有限数值`);
        }
      } else if (typeof value !== 'boolean') {
        throw new VectorStoreError(
          'INVALID_INPUT',
          `filters.metadata.${key} 只支持字符串、数值或布尔值`,
        );
      }
    }
  }
}

function assertOptionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new VectorStoreError(
      'INVALID_INPUT',
      `${field} 必须是 1~${maxItems} 个元素的数组`,
    );
  }

  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLength) {
      throw new VectorStoreError(
        'INVALID_INPUT',
        `${field} 的每个元素必须是 1~${maxLength} 字符的非空字符串`,
      );
    }
  }
}

function assertOptionalText(value: unknown, field: string, maxLength: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new VectorStoreError(
      'INVALID_INPUT',
      `${field} 必须是 1~${maxLength} 字符的非空字符串`,
    );
  }
}

/** 去掉首尾空白并统一小写，避免「差旅.pdf 」和「差旅.pdf」被当成不同条件。 */
function normalizeFilters(filters?: VectorSearchFilters): VectorSearchFilters | undefined {
  if (!filters) return undefined;

  return {
    documentIds: filters.documentIds?.map((value) => value.trim()),
    formats: filters.formats?.map((value) => value.trim().toLowerCase()),
    filenameContains: filters.filenameContains?.trim(),
    titleContains: filters.titleContains?.trim(),
    sectionPathPrefix: filters.sectionPathPrefix?.map((value) => value.trim()),
    metadata: filters.metadata,
  };
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VectorStoreError('INVALID_INPUT', `${field} 不能为空`);
  }
}

function mapSearchRow(row: RawSearchRow): VectorSearchHit {
  const similarity = Number(row.similarity);

  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    filename: row.filename,
    format: row.format,
    chunkIndex: row.chunkIndex,
    content: row.content,
    page: row.page === null ? null : Number(row.page),
    pageEnd: row.pageEnd === null ? null : Number(row.pageEnd),
    sectionPath: normalizeStringArray(row.sectionPath),
    blockIndexes: normalizeNumberArray(row.blockIndexes),
    tokenCount: Number(row.tokenCount),
    similarity: Number.isFinite(similarity) ? similarity : 0,
  };
}
