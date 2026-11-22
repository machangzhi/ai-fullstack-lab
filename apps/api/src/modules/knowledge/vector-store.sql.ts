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
import { VECTOR_DIMENSION } from './vector-store.types';

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
}

export function buildSearchSql(params: BuildSearchSqlParams): Prisma.Sql {
  const documentFilter = params.documentId
    ? Prisma.sql`AND dc."documentId" = ${params.documentId}`
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
      ${thresholdFilter}
    ORDER BY dc."embedding" <=> ${params.vectorLiteral}::vector
    LIMIT ${params.topK}
  `;
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
