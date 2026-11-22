/**
 * 文件作用：在候选集上执行检索策略（Week 6 Day 1）。
 *
 * 处理顺序固定为：
 *   1. Metadata Filter：硬约束，先缩小范围；
 *   2. 计算关键词分数：纯函数，方便解释与测试；
 *   3. 按模式打分：vector / keyword / hybrid；
 *   4. 阈值过滤（只作用于向量相似度）；
 *   5. 排序、截断 Top-K、附上名次。
 *
 * 为什么先过滤再排序：
 * Top-K 是「名额」而不是「候选池」。先排序再过滤会导致名额被无关文档占掉，
 * 最终返回条数可能远小于 K，因此过滤必须前置。
 *
 * 为什么阈值只作用于相似度：
 * 相似度有明确的 0~1 语义，而关键词覆盖率与 RRF 分数的量纲不同；
 * 把阈值套到最终分数上会让不同模式下的参数不可比。
 */

import { RetrievalError } from './errors';
import { matchesRetrievalFilters } from './filters';
import { keywordScore } from './keyword';
import type {
  HybridFusion,
  RetrievalCandidate,
  RetrievalHit,
  RetrievalMode,
  RetrievalOptions,
} from './types';

const MODES: RetrievalMode[] = ['vector', 'keyword', 'hybrid'];
const FUSIONS: HybridFusion[] = ['weighted', 'rrf'];

export function searchCandidates(
  candidates: RetrievalCandidate[],
  query: string,
  options: RetrievalOptions = {},
): RetrievalHit[] {
  if (!Array.isArray(candidates)) {
    throw new RetrievalError('INVALID_INPUT', 'candidates 必须是数组');
  }
  if (typeof query !== 'string' || !query.trim()) {
    throw new RetrievalError('INVALID_INPUT', 'query 不能为空');
  }

  const topK = options.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    throw new RetrievalError('INVALID_INPUT', 'topK 必须是 1~50 的整数');
  }

  const minSimilarity = options.minSimilarity ?? 0;
  if (
    typeof minSimilarity !== 'number' ||
    !Number.isFinite(minSimilarity) ||
    minSimilarity < 0 ||
    minSimilarity > 1
  ) {
    throw new RetrievalError('INVALID_INPUT', 'minSimilarity 必须是 0~1 之间的数值');
  }

  const mode = options.mode ?? 'vector';
  if (!MODES.includes(mode)) {
    throw new RetrievalError('INVALID_INPUT', `未知检索模式：${String(mode)}`);
  }

  const fusion = options.fusion ?? 'weighted';
  if (!FUSIONS.includes(fusion)) {
    throw new RetrievalError('INVALID_INPUT', `未知融合方式：${String(fusion)}`);
  }

  const vectorWeight = options.vectorWeight ?? 0.7;
  if (
    typeof vectorWeight !== 'number' ||
    !Number.isFinite(vectorWeight) ||
    vectorWeight < 0 ||
    vectorWeight > 1
  ) {
    throw new RetrievalError('INVALID_INPUT', 'vectorWeight 必须是 0~1 之间的数值');
  }

  const rrfK = options.rrfK ?? 60;
  if (!Number.isInteger(rrfK) || rrfK < 1 || rrfK > 1000) {
    throw new RetrievalError('INVALID_INPUT', 'rrfK 必须是 1~1000 的整数');
  }

  const filtered = candidates.filter((candidate) =>
    matchesRetrievalFilters(candidate, options.filters),
  );

  const keywordScores = new Map<string, number>();
  for (const candidate of filtered) {
    keywordScores.set(candidate.chunkId, keywordScore(query, candidate.content));
  }

  let scored: Array<RetrievalCandidate & { keywordScore: number; score: number }>;

  if (mode === 'vector') {
    scored = filtered
      .filter((candidate) => candidate.similarity >= minSimilarity)
      .map((candidate) => ({
        ...candidate,
        keywordScore: keywordScores.get(candidate.chunkId) ?? 0,
        score: candidate.similarity,
      }));
  } else if (mode === 'keyword') {
    // 纯关键词模式不应用向量阈值：没有向量分数时，"0.5" 没有可比意义。
    scored = filtered
      .map((candidate) => ({
        ...candidate,
        keywordScore: keywordScores.get(candidate.chunkId) ?? 0,
        score: keywordScores.get(candidate.chunkId) ?? 0,
      }))
      .filter((candidate) => candidate.keywordScore > 0);
  } else if (fusion === 'weighted') {
    scored = filtered
      .filter((candidate) => candidate.similarity >= minSimilarity)
      .map((candidate) => {
        const lexical = keywordScores.get(candidate.chunkId) ?? 0;
        return {
          ...candidate,
          keywordScore: lexical,
          score: clamp01(candidate.similarity) * vectorWeight + lexical * (1 - vectorWeight),
        };
      });
  } else {
    return reciprocalRankFusion(filtered, keywordScores, {
      topK,
      minSimilarity,
      vectorWeight,
      rrfK,
    });
  }

  scored.sort(compareScored);

  return scored.slice(0, topK).map((hit, index) => ({
    ...hit,
    rank: index + 1,
  }));
}

interface RrfOptions {
  topK: number;
  minSimilarity: number;
  vectorWeight: number;
  rrfK: number;
}

/**
 * Reciprocal Rank Fusion：
 *   score = w / (k + rankVector) + (1 - w) / (k + rankKeyword)
 *
 * 它只看名次，不看原始分数，因此不需要把余弦相似度和 BM25/关键词分数
 * 归一化到同一量纲。缺点是无法区分「第一名比第二名好多少」。
 */
function reciprocalRankFusion(
  candidates: RetrievalCandidate[],
  keywordScores: Map<string, number>,
  options: RrfOptions,
): RetrievalHit[] {
  const vectorRanked = candidates
    .filter((candidate) => candidate.similarity >= options.minSimilarity)
    .sort(
      (left, right) =>
        right.similarity - left.similarity || left.chunkId.localeCompare(right.chunkId),
    );

  const keywordRanked = candidates
    .filter((candidate) => (keywordScores.get(candidate.chunkId) ?? 0) > 0)
    .sort((left, right) => {
      const diff =
        (keywordScores.get(right.chunkId) ?? 0) - (keywordScores.get(left.chunkId) ?? 0);
      return diff || right.similarity - left.similarity || left.chunkId.localeCompare(right.chunkId);
    });

  const merged = new Map<
    string,
    { candidate: RetrievalCandidate; keywordScore: number; score: number }
  >();

  const add = (candidate: RetrievalCandidate, score: number) => {
    const existing = merged.get(candidate.chunkId);
    const lexical = keywordScores.get(candidate.chunkId) ?? 0;
    if (existing) {
      existing.score += score;
      return;
    }
    merged.set(candidate.chunkId, { candidate, keywordScore: lexical, score });
  };

  vectorRanked.forEach((candidate, index) => {
    add(candidate, options.vectorWeight / (options.rrfK + index + 1));
  });
  keywordRanked.forEach((candidate, index) => {
    add(candidate, (1 - options.vectorWeight) / (options.rrfK + index + 1));
  });

  return [...merged.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.similarity - left.candidate.similarity ||
        left.candidate.chunkId.localeCompare(right.candidate.chunkId),
    )
    .slice(0, options.topK)
    .map((entry, index) => ({
      ...entry.candidate,
      keywordScore: entry.keywordScore,
      score: entry.score,
      rank: index + 1,
    }));
}

function compareScored(
  left: RetrievalCandidate & { score: number },
  right: RetrievalCandidate & { score: number },
): number {
  return (
    right.score - left.score ||
    right.similarity - left.similarity ||
    left.chunkId.localeCompare(right.chunkId)
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
