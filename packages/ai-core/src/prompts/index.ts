/**
 * 文件作用：prompts 目录的公共出口。
 *
 * 只导出类型、ID 常量和取值函数，不导出具体提示词对象：
 * 调用方拿到的是「ID → 模板」的受控入口，避免业务代码直接依赖某个模板的文案。
 */

export {
  INJECTION_GUARD,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  PROMPT_TEMPLATE_IDS,
  USER_INPUT_CLOSE,
  USER_INPUT_OPEN,
  buildConversationMessages,
  getPromptTemplate,
  trimChatHistory,
} from './templates';
export type {
  ChatHistoryMessage,
  PromptMessage,
  PromptTemplate,
  PromptTemplateId,
} from './templates';
