/**
 * 文件作用：对比不同 K 值与阈值的检索结果（Week 6 Day 1）。
 *
 * 对比不是「看哪组参数分数最高」，而是回答三个问题：
 * 1. 这组参数能召回多少片段（覆盖率）？
 * 2. 与基线相比，结果是否稳定（重合度、Top-1 是否变化）？
 * 3. 增加召回是否只是引入了低相似度噪声（平均 Top-1 相似度）？
 *
 * 指标只依赖候选集，不访问数据库与 Embedding 服务，因此可以在 CI 中离线运行。
 */

import { RetrievalError } from './errors';
import { searchCandidates } from './search';
import type {
  RetrievalConfig,
  RetrievalConfigComparison,
  RetrievalComparisonReport,
  RetrievalHit,
  RetrievalQueryCandidates,
  RetrievalQueryResult,
} from './types';

export function compareRetrievalConfigs(
  datasets: RetrievalQueryCandidates[],
  configs: RetrievalConfig[],
): RetrievalComparisonReport {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new RetrievalError('INVALID_INPUT', '对比至少需要一条查询');
  }
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new RetrievalError('INVALID_INPUT', '对比至少需要一个检索配置');
  }

  const baseline = configs[0];
  const baselineResults = runConfig(datasets, baseline);
  const baselineByQuery = new Map(
    baselineResults.perQuery.map((result) => [result.query, result] as const),
  );

  const comparisons = configs.map((config, index) => {
    const results = index === 0 ? baselineResults : runConfig(datasets, config);

    let overlapSum = 0;
    let top1Same = 0;
    for (const result of results.perQuery) {
      const reference = baselineByQuery.get(result.query);
      overlapSum += jaccard(result.chunkIds, reference?.chunkIds ?? []);
      if (result.top1ChunkId === reference?.top1ChunkId) top1Same += 1;
    }

    const topSimilarities = results.perQuery
      .map((result) => result.top1Similarity)
      .filter((value): value is number => value !== null);
    const topScores = results.perQuery
      .map((result) => result.top1Score)
      .filter((value): value is number => value !== null);

    return {
      name: config.name,
      mode: config.options.mode ?? 'vector',
      topK: config.options.topK ?? 5,
      minSimilarity: config.options.minSimilarity ?? 0,
      queryCount: datasets.length,
      queriesWithHits: results.queriesWithHits,
      hitRate: results.queriesWithHits / datasets.length,
      totalHits: results.totalHits,
      avgHitsPerQuery: results.totalHits / datasets.length,
      avgTop1Similarity: average(topSimilarities),
      avgTop1Score: average(topScores),
      baselineOverlap: overlapSum / datasets.length,
      top1SameRate: top1Same / datasets.length,
      perQuery: results.perQuery,
    } satisfies RetrievalConfigComparison;
  });

  return { baseline: baseline.name, configs: comparisons };
}

interface ConfigRun {
  queriesWithHits: number;
  totalHits: number;
  perQuery: RetrievalQueryResult[];
}

function runConfig(datasets: RetrievalQueryCandidates[], config: RetrievalConfig): ConfigRun {
  const perQuery: RetrievalQueryResult[] = [];
  let totalHits = 0;
  let queriesWithHits = 0;

  for (const dataset of datasets) {
    const hits = searchCandidates(dataset.candidates, dataset.query, config.options);
    totalHits += hits.length;
    if (hits.length > 0) queriesWithHits += 1;
    perQuery.push(toQueryResult(dataset.query, hits));
  }

  return { queriesWithHits, totalHits, perQuery };
}

function toQueryResult(query: string, hits: RetrievalHit[]): RetrievalQueryResult {
  const top = hits[0] ?? null;
  return {
    query,
    hitCount: hits.length,
    top1ChunkId: top?.chunkId ?? null,
    top1Similarity: top?.similarity ?? null,
    top1Score: top?.score ?? null,
    chunkIds: hits.map((hit) => hit.chunkId),
  };
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 && rightSet.size === 0) return 1;

  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
