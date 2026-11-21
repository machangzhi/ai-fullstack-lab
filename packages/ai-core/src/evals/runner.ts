/**
 * 文件作用：可注入模型调用的评测执行器（Week 4 Day 5）。
 *
 * 关键概念：
 * 1. 执行器只负责「遍历用例 → 调用模型 → 校验 → 汇总」，不关心模型是真实 HTTP
 *    还是测试里的 Mock。模型调用通过参数注入，所以单元测试可以完全离线运行。
 * 2. 延迟由执行器统一测量，避免每个调用方各写一套计时逻辑。
 * 3. 用例串行执行：并发调用会互相争抢连接与限流额度，测出来的延迟无法比较。
 */

import { runChecks } from './checks';
import {
  summarizeResults,
  type EvalCaseDefinition,
  type EvalCaseResult,
  type EvalSummary,
  type EvalVariantDefinition,
  type TokenUsage,
} from './metrics';

/** 模型调用成功后的最小返回值；latency 由执行器测量，调用方不用关心。 */
export interface ModelReply {
  content: string;
  usage?: TokenUsage | null;
  model?: string;
}

/** 调用模型时需要的上下文；评测脚本据此拼装生产同款消息。 */
export interface EvalCallContext {
  variantId: string;
  caseId: string;
  template: string;
  systemPrompt: string;
  userInput: string;
}

export type ModelCaller = (context: EvalCallContext) => Promise<ModelReply>;

export interface RunVariantOptions {
  variant: EvalVariantDefinition;
  /** 只应包含与该版本 template 匹配的用例。 */
  cases: EvalCaseDefinition[];
  systemPrompt: string;
  callModel: ModelCaller;
  /** 注入时钟，便于测试得到稳定的延迟数值。 */
  now?: () => number;
  /** 每条用例完成后回调，脚本用它输出实时进度。 */
  onResult?: (result: EvalCaseResult) => void;
}

export interface VariantRun {
  summary: EvalSummary;
  results: EvalCaseResult[];
  /** 本次实际返回的模型名，便于确认评测没有跑错配置。 */
  models: string[];
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 执行一个版本的全部用例；单条失败不会中断整轮评测。 */
export async function runVariant(options: RunVariantOptions): Promise<VariantRun> {
  const { variant, cases, systemPrompt, callModel, now = Date.now, onResult } = options;
  const results: EvalCaseResult[] = [];
  const models = new Set<string>();

  for (const testCase of cases) {
    const startedAt = now();
    let result: EvalCaseResult;

    try {
      const reply = await callModel({
        variantId: variant.id,
        caseId: testCase.id,
        template: testCase.template,
        systemPrompt,
        userInput: testCase.input,
      });
      const latencyMs = Math.max(0, now() - startedAt);
      if (reply.model) models.add(reply.model);

      const failures = runChecks(testCase.checks, reply.content);
      result = {
        caseId: testCase.id,
        template: testCase.template,
        input: testCase.input,
        expected: testCase.expected ?? '',
        output: reply.content,
        passed: failures.length === 0,
        succeeded: true,
        failures,
        latencyMs,
        usage: reply.usage ?? null,
      };
    } catch (error) {
      // 调用失败也要记录耗时：它说明这次请求卡了多久，但不进入延迟分位数统计。
      result = {
        caseId: testCase.id,
        template: testCase.template,
        input: testCase.input,
        expected: testCase.expected ?? '',
        output: '',
        passed: false,
        succeeded: false,
        failures: [`调用失败：${readErrorMessage(error)}`],
        latencyMs: Math.max(0, now() - startedAt),
        usage: null,
      };
    }

    results.push(result);
    onResult?.(result);
  }

  return {
    summary: summarizeResults(variant, results),
    results,
    models: [...models],
  };
}
