/**
 * 文件作用：结构化输出的公共出口。
 *
 * 业务代码只需要「提示词 + 解析函数 + 结果类型」，
 * 不必直接依赖 zod，也不应该自己再写一套 JSON 解析。
 */

export {
  ENTITY_TYPES,
  FEEDBACK_CATEGORIES,
  entityExtractionSchema,
  feedbackClassificationSchema,
  parseEntityExtraction,
  parseFeedbackClassification,
  parseStructuredJson,
} from './parse';
export type {
  EntityExtraction,
  FeedbackClassification,
  StructuredParseFailureReason,
  StructuredParseResult,
} from './parse';
export {
  CLASSIFY_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  buildStructuredUserMessage,
} from './prompts';
