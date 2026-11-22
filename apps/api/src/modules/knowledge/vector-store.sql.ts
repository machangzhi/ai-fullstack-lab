/**
 * 文件作用：向量库的原生 SQL 构造与结果清洗（Week 5 Day 5）。
 *
 * 为什么不用 Prisma Client 查询向量：
 * - Prisma 不支持 vector 字段类型，无法 select / where / orderBy；
 * - 相似度排序需要 pgvector 的 `<=>` 运算符，只能写原生 SQL。
 *
 * 安全约束：向量本身以「数字字符串」拼成 `[0.1,0.2,...]`，作为参数传入后再
 * `::vector` 转换，不把用户输入直接拼进 SQL 文本。
 */

import { Prisma } from '@prisma/client';
import { VectorStoreError } from './vector-store.errors';
import { VECTOR_DIMENSION, type VectorSearchFilters } from './vector-store.types';

export function toVectorLiteral(embedding: number[]): string {
  if (!Array.isArray(embedding) || embedding.length !== VECTOR_DIMENSION) {
    throw new VectorStoreError(
      'INVALID_VECTOR',
      `向量维度必须是 ${VECTOR_DIMENSION}，当前为 ${Array.isArray(embedding) ? embedding.length : '非数组'}`,
    );
  }

  const parts = embedding.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new VectorStoreError('INVALID_VECTOR', `向量第 ${index} 个值不是有限数值`);
    }
    return String(value);
  });

  return `[${parts.join(',')}]`;
}

export interface BuildSearchSqlParams {
  vectorLiteral: string;
  topK: number;
  documentId?: string;
  minSimilarity?: number;
  filters?: VectorSearchFilters;
}

export function buildSearchSql(params: BuildSearchSqlParams): Prisma.Sql {
  const documentFilter = params.documentId
    ? Prisma.sql`AND dc."documentId" = ${params.documentId}`
    : Prisma.empty;

  const documentIdsFilter = params.filters?.documentIds?.length
    ? Prisma.sql`AND d."id" IN (${Prisma.join(params.filters.documentIds)})`
    : Prisma.empty;

  const formatFilter = params.filters?.formats?.length
    ? Prisma.sql`AND d."format" IN (${Prisma.join(params.filters.formats)})`
    : Prisma.empty;

  const filenameFilter = params.filters?.filenameContains
    ? Prisma.sql`AND d."filename" ILIKE ${toLikePattern(params.filters.filenameContains)} ESCAPE '\\'`
    : Prisma.empty;

  const titleFilter = params.filters?.titleContains
    ? Prisma.sql`AND d."title" ILIKE ${toLikePattern(params.filters.titleContains)} ESCAPE '\\'`
    : Prisma.empty;

  const sectionPathFilter = buildSectionPathFilter(params.filters?.sectionPathPrefix);

  const metadataFilter =
    params.filters?.metadata && Object.keys(params.filters.metadata).length > 0
      ? Prisma.sql`AND d."metadata" @> ${JSON.stringify(params.filters.metadata)}::jsonb`
      : Prisma.empty;

  const thresholdFilter =
    params.minSimilarity === undefined
      ? Prisma.empty
      : Prisma.sql`AND (1 - (dc."embedding" <=> ${params.vectorLiteral}::vector)) >= ${params.minSimilarity}`;

  return Prisma.sql`
    SELECT
      dc."id" AS "chunkId",
      dc."documentId" AS "documentId",
      d."title" AS "documentTitle",
      d."filename" AS "filename",
      d."format" AS "format",
      dc."chunkIndex" AS "chunkIndex",
      dc."content" AS "content",
      dc."page" AS "page",
      dc."pageEnd" AS "pageEnd",
      dc."sectionPath" AS "sectionPath",
      dc."blockIndexes" AS "blockIndexes",
      dc."tokenCount" AS "tokenCount",
      1 - (dc."embedding" <=> ${params.vectorLiteral}::vector) AS "similarity"
    FROM "document_chunks" dc
    INNER JOIN "documents" d ON d."id" = dc."documentId"
    WHERE d."status" = 'READY'
      ${documentFilter}
      ${documentIdsFilter}
      ${formatFilter}
      ${filenameFilter}
      ${titleFilter}
      ${sectionPathFilter}
      ${metadataFilter}
      ${thresholdFilter}
    ORDER BY dc."embedding" <=> ${params.vectorLiteral}::vector
    LIMIT ${params.topK}
  `;
}

/**
 * 章节前缀过滤：逐层比较 jsonb 数组的第 N 个元素。
 *
 * 为什么不用 `@>`：
 * `sectionPath @> '["差旅制度"]'::jsonb` 只判断「包含元素」，不关心层级顺序；
 * 而 ["住宿标准", "差旅制度"] 与 ["差旅制度", "住宿标准"] 在业务上完全不同。
 * 逐层比较可以表达「必须是这个路径开头」。
 */
function buildSectionPathFilter(prefix?: string[]): Prisma.Sql {
  if (!prefix || prefix.length === 0) return Prisma.empty;

  const conditions = prefix.map(
    (segment, index) => Prisma.sql`dc."sectionPath"->>${index}::int = ${segment}`,
  );
  return Prisma.sql`AND (${Prisma.join(conditions, ' AND ')})`;
}

/**
 * 构造 ILIKE 模式，并转义用户输入中的通配符。
 *
 * 如果不转义，用户传入 `%` 会匹配任意内容，`_` 会匹配任意单字符，
 * 让「文件名包含」变成范围过大的查询。
 */
function toLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

/** 数据库 jsonb 在 Prisma 里可能是数组，也可能是字符串，统一成 string[]。 */
export function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

/** 同上，用于 blockIndexes：只保留非负整数。 */
export function normalizeNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0,
    );
  }

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter(
            (item): item is number =>
              typeof item === 'number' && Number.isInteger(item) && item >= 0,
          )
        : [];
    } catch {
      return [];
    }
  }

  return [];
}
