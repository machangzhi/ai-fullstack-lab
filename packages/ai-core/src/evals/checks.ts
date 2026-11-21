/**
 * 文件作用：Prompt 评测的确定性规则校验（Week 4 Day 5）。
 *
 * 关键概念：
 * 1. 评测不用「裁判模型」打分，只用可重复的字符串与结构规则，避免主观判断污染结论。
 * 2. 规则刻意保守：宁可放过一个模糊问题，也不要制造无法解释的失败。
 * 3. 分类结果复用生产解析器（parseFeedbackClassification），这样评测校验的
 *    就是线上真正接受的结构，而不是另写一套宽松规则。
 */

import { parseFeedbackClassification } from '../structured';

/** 单条用例的检查规则；所有字段都可省略，空对象表示只要求模型正常返回。 */
export interface EvalChecks {
  /** 必须全部出现的关键词。 */
  contains?: string[];
  /** 至少出现一个的关键词。 */
  containsAny?: string[];
  /** 禁止出现的内容，例如「保证退款」这类越权承诺。 */
  notContains?: string[];
  /** 输出字符数上限，用来约束啰嗦程度。 */
  maxChars?: number;
  /** 是否按分类 JSON 解析；开启后 category 才会生效。 */
  json?: boolean;
  /** 允许的类别集合；留空表示只校验 JSON 结构。 */
  category?: string[];
}

/**
 * 执行全部检查，返回失败原因数组；空数组表示通过。
 *
 * 返回原因而不是布尔值，是为了让报告能直接说明「为什么失败」，
 * 调 Prompt 时不用再手工翻模型输出。
 */
export function runChecks(checks: EvalChecks, content: string): string[] {
  const failures: string[] = [];

  for (const text of checks.contains ?? []) {
    if (!content.includes(text)) failures.push(`缺少「${text}」`);
  }

  const any = checks.containsAny ?? [];
  if (any.length > 0 && !any.some((text) => content.includes(text))) {
    failures.push(`未包含任一：${any.join(' / ')}`);
  }

  for (const text of checks.notContains ?? []) {
    if (content.includes(text)) failures.push(`出现禁止内容「${text}」`);
  }

  if (checks.maxChars !== undefined && content.length > checks.maxChars) {
    failures.push(`长度 ${content.length} 超过 ${checks.maxChars}`);
  }

  if (checks.json) {
    const parsed = parseFeedbackClassification(content);
    if (!parsed.success) {
      failures.push(`JSON 未通过校验：${parsed.message}`);
      return failures;
    }

    const categories = checks.category ?? [];
    if (categories.length > 0 && !categories.includes(parsed.data.category)) {
      failures.push(`类别为「${parsed.data.category}」，期望「${categories.join(' / ')}」`);
    }
  }

  return failures;
}
