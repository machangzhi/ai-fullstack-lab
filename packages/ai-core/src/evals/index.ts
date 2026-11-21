/**
 * 文件作用：评测模块的公共出口（Week 4 Day 5）。
 *
 * 分成三块：
 * - checks：确定性规则校验；
 * - metrics：准确率、成功率、失败率与延迟分位数；
 * - runner：注入模型调用后的批量执行。
 */

export { runChecks } from './checks';
export type { EvalChecks } from './checks';
export { compareSummaries, summarizeLatency, summarizeResults } from './metrics';
export type {
  EvalCaseDefinition,
  EvalCaseResult,
  EvalComparison,
  EvalSummary,
  EvalVariantDefinition,
  LatencyStats,
  TokenUsage,
} from './metrics';
export { runVariant } from './runner';
export type {
  EvalCallContext,
  ModelCaller,
  ModelReply,
  RunVariantOptions,
  VariantRun,
} from './runner';
