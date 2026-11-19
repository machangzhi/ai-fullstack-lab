/**
 * 文件作用：结构化输出的 Zod schema 与解析器（Week 3 Day 4）。
 *
 * 关键概念：
 * 1. JSON Schema 描述「结构长什么样」，Zod 是它在 TypeScript 里的可执行版本：
 *    同一份定义既做运行时校验，又能推导出静态类型，不用手写两份。
 * 2. 模型输出是**外部输入**，必须当作不可信数据处理。即使提示词要求「只输出 JSON」，
 *    模型仍可能加 Markdown 代码块、前后解释、少字段或类型错误。
 * 3. 解析策略：先去掉代码围栏，再截取第一个 `{` 到最后一个 `}`，最后 JSON.parse。
 *    这一步只解决「格式噪声」，字段合法性仍然交给 schema 判断，不能混为一谈。
 * 4. 失败分为三类，便于上层决定是否重试：
 *    - empty：模型返回空内容
 *    - invalid_json：根本解析不出 JSON
 *    - schema_mismatch：能解析，但字段/类型/范围不符合约定
 */

import { z } from 'zod';

/** 用户反馈的固定类别；Day 3 的提示词已经预告了这套枚举。 */
export const FEEDBACK_CATEGORIES = [
  '产品质量',
  '物流配送',
  '售后服务',
  '账号与支付',
  '其他',
] as const;

export const feedbackClassificationSchema = z
  .object({
    category: z.enum(FEEDBACK_CATEGORIES),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(40),
  })
  .strict();

export type FeedbackClassification = z.infer<typeof feedbackClassificationSchema>;

/** 实体类型保持有限枚举，避免模型自由发明类别导致下游无法处理。 */
export const ENTITY_TYPES = ['人物', '组织', '产品', '时间', '金额', '其他'] as const;

export const entityExtractionSchema = z
  .object({
    entities: z
      .array(
        z
          .object({
            type: z.enum(ENTITY_TYPES),
            value: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export type EntityExtraction = z.infer<typeof entityExtractionSchema>;

export type StructuredParseFailureReason = 'empty' | 'invalid_json' | 'schema_mismatch';

export type StructuredParseResult<T> =
  | { success: true; data: T }
  | { success: false; reason: StructuredParseFailureReason; message: string };

/** 去掉 ```json ... ``` 或 ``` ... ``` 围栏，模型经常自作主张加。 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1] : trimmed;
}

/**
 * 通用解析入口：只负责「提取 JSON → 校验结构」，不做任何业务修正。
 * 不成功后返回稳定原因，调用方可据此决定是否值得重试。
 */
export function parseStructuredJson<T>(
  schema: z.ZodType<T>,
  rawText: string,
): StructuredParseResult<T> {
  const text = stripCodeFence(rawText);
  if (!text) {
    return { success: false, reason: 'empty', message: '模型返回了空内容。' };
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { success: false, reason: 'invalid_json', message: '模型输出不是合法 JSON。' };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'root';
    return {
      success: false,
      reason: 'schema_mismatch',
      message: `字段 ${path} 不符合约定：${issue?.message ?? '结构错误'}`,
    };
  }

  return { success: true, data: result.data };
}

export function parseFeedbackClassification(
  rawText: string,
): StructuredParseResult<FeedbackClassification> {
  return parseStructuredJson(feedbackClassificationSchema, rawText);
}

export function parseEntityExtraction(rawText: string): StructuredParseResult<EntityExtraction> {
  return parseStructuredJson(entityExtractionSchema, rawText);
}
