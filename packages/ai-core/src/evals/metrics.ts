/**
 * 文件作用：评测结果的指标计算（Week 4 Day 5）。
 *
 * 关键概念：
 * 1. 一次评测里「模型没答对」和「模型没答」是两件事，必须分开统计：
 *    - 成功率 successRate：调用成功（拿到正常响应）的比例；
 *    - 准确率 accuracy：调用成功且通过规则校验的比例；
 *    - 失败率 failureRate：调用失败（超时、HTTP 错误、断网）的比例。
 * 2. 延迟只统计调用成功的用例：超时请求的耗时取决于超时阈值，
 *    混进平均值会把「网络故障」误读成「模型变慢」。
 * 3. P50/P95 用线性插值计算，与常见监控系统口径一致；样本很少时数值仅供趋势参考。
 */

import type { EvalChecks } from './checks';

/** 模型返回的 Token 用量；缺省时按 0 处理，不影响准确率统计。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 数据集里的单条用例（与 JSON 文件字段一一对应）。 */
export interface EvalCaseDefinition {
  id: string;
  template: string;
  input: string;
  /** 人类可读的期望结果，写入报告，不参与程序判断。 */
  expected?: string;
  checks: EvalChecks;
}

/** 数据集里的一个 Prompt 版本。 */
export interface EvalVariantDefinition {
  id: string;
  template: string;
  note?: string;
}

/** 单条用例的执行结果，保留模型原始输出便于复盘。 */
export interface EvalCaseResult {
  caseId: string;
  template: string;
  input: string;
  expected: string;
  /** 模型原始输出；调用失败时为空字符串。 */
  output: string;
  /** 是否通过规则校验。 */
  passed: boolean;
  /** 调用本身是否成功；false 表示网络、超时或 HTTP 错误。 */
  succeeded: boolean;
  failures: string[];
  latencyMs: number;
  usage: TokenUsage | null;
}

export interface LatencyStats {
  /** 参与统计的样本数（只含调用成功的用例）。 */
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

/** 一个 Prompt 版本在一组用例上的汇总指标。 */
export interface EvalSummary {
  variantId: string;
  template: string;
  note: string;
  total: number;
  /** 通过规则校验的用例数。 */
  passed: number;
  /** 调用成功但未通过校验的用例数。 */
  checkFailed: number;
  /** 调用失败的用例数。 */
  errored: number;
  accuracy: number;
  successRate: number;
  failureRate: number;
  latency: LatencyStats;
  totalTokens: number;
}

/** 两个版本的指标差值；正值表示候选版本更高/更慢。 */
export interface EvalComparison {
  template: string;
  baselineVariant: string;
  candidateVariant: string;
  accuracyDelta: number;
  successRateDelta: number;
  avgLatencyDeltaMs: number;
  p50LatencyDeltaMs: number;
  p95LatencyDeltaMs: number;
}

/** 线性插值分位数：p 取 0～1，空数组返回 0。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** 汇总一组毫秒值；输入无需排序，函数内部会复制后排序，避免修改调用方数据。 */
export function summarizeLatency(values: number[]): LatencyStats {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  }

  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

export function summarizeResults(
  variant: EvalVariantDefinition,
  results: EvalCaseResult[],
): EvalSummary {
  const total = results.length;
  const passed = results.filter((item) => item.passed).length;
  const succeededResults = results.filter((item) => item.succeeded);
  const errored = total - succeededResults.length;

  return {
    variantId: variant.id,
    template: variant.template,
    note: variant.note ?? '',
    total,
    passed,
    checkFailed: succeededResults.length - passed,
    errored,
    accuracy: total === 0 ? 0 : passed / total,
    successRate: total === 0 ? 0 : succeededResults.length / total,
    failureRate: total === 0 ? 0 : errored / total,
    latency: summarizeLatency(succeededResults.map((item) => item.latencyMs)),
    totalTokens: results.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0),
  };
}

/** 计算候选版本相对基线版本的指标变化；报告用正值/负值表达方向。 */
export function compareSummaries(
  baseline: EvalSummary,
  candidate: EvalSummary,
): EvalComparison {
  return {
    template: candidate.template,
    baselineVariant: baseline.variantId,
    candidateVariant: candidate.variantId,
    accuracyDelta: candidate.accuracy - baseline.accuracy,
    successRateDelta: candidate.successRate - baseline.successRate,
    avgLatencyDeltaMs: candidate.latency.avgMs - baseline.latency.avgMs,
    p50LatencyDeltaMs: candidate.latency.p50Ms - baseline.latency.p50Ms,
    p95LatencyDeltaMs: candidate.latency.p95Ms - baseline.latency.p95Ms,
  };
}
