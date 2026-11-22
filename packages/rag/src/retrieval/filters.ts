/**
 * 文件作用：检索结果的硬过滤（Week 6 Day 1）。
 *
 * Metadata Filter 的价值：
 * - 用户只想问「差旅制度」时，不应该返回采购制度里的高相似片段；
 * - 多知识库/多租户场景下，过滤是权限与范围控制的一部分；
 * - 先过滤再排序，可以避免「无关但相似」的片段挤占 Top-K 名额。
 *
 * 这里的实现用于离线实验；在线 API 使用等价参数化 SQL，
 * 两边语义必须保持一致（见 apps/api 的 vector-store.sql.ts）。
 */

import type { RetrievalCandidate, RetrievalFilters } from './types';

export function matchesRetrievalFilters(
  candidate: RetrievalCandidate,
  filters?: RetrievalFilters,
): boolean {
  if (!filters) return true;

  const documentIds = normalizeStrings(filters.documentIds);
  if (documentIds.length > 0 && !documentIds.includes(candidate.documentId)) {
    return false;
  }

  const formats = normalizeStrings(filters.formats).map((format) => format.toLowerCase());
  if (formats.length > 0) {
    const format = candidate.format?.trim().toLowerCase();
    if (!format || !formats.includes(format)) return false;
  }

  const filenameContains = filters.filenameContains?.trim();
  if (
    filenameContains &&
    !candidate.filename.toLowerCase().includes(filenameContains.toLowerCase())
  ) {
    return false;
  }

  const titleContains = filters.titleContains?.trim();
  if (
    titleContains &&
    !candidate.documentTitle.toLowerCase().includes(titleContains.toLowerCase())
  ) {
    return false;
  }

  const sectionPathPrefix = normalizeStrings(filters.sectionPathPrefix);
  if (sectionPathPrefix.length > 0) {
    const sectionPath = candidate.sectionPath ?? [];
    if (sectionPath.length < sectionPathPrefix.length) return false;
    for (let index = 0; index < sectionPathPrefix.length; index += 1) {
      if (sectionPath[index] !== sectionPathPrefix[index]) return false;
    }
  }

  return true;
}

function normalizeStrings(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
}
