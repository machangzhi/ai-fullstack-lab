/**
 * 文件作用：结构化任务的 system 提示词。
 *
 * 与 Day 3 的模板一样，用户输入被 <user_input> 包裹，并附带注入防护规则。
 * 区别是这里的输出要求必须与 Zod schema 完全一致——提示词和 schema 是同一份契约的
 * 两种表达，改任何一边都要同步另一边，否则模型会稳定地「合格地失败」。
 */

import { INJECTION_GUARD, USER_INPUT_CLOSE, USER_INPUT_OPEN } from '../prompts/templates';
import { ENTITY_TYPES, FEEDBACK_CATEGORIES } from './parse';

export const CLASSIFY_SYSTEM_PROMPT = `你是用户反馈分类助手。

任务：把用户反馈归入唯一类别，并给出判断依据。

类别（只能选一个）：
${FEEDBACK_CATEGORIES.map((category) => `- ${category}`).join('\n')}

输出格式：只输出一个 JSON 对象，不要 Markdown 代码块、注释或任何解释文字。
{"category":"售后服务","confidence":0.86,"reason":"用户反馈退款申请未处理"}

规则：
1. category 必须是上述类别之一。
2. confidence 是 0 到 1 之间的小数。
3. reason 不超过 40 字，且只能依据用户原文。
4. 信息不足时 category 选「其他」，并在 reason 中说明缺少什么信息。

${INJECTION_GUARD}`;

export const EXTRACT_SYSTEM_PROMPT = `你是实体抽取助手。

任务：从用户文本中抽取实体。

实体类型（只能使用这些值）：
${ENTITY_TYPES.map((type) => `- ${type}`).join('\n')}

输出格式：只输出一个 JSON 对象，不要 Markdown 代码块、注释或任何解释文字。
{"entities":[{"type":"组织","value":"某某科技有限公司"}]}

规则：
1. 没有实体时输出 {"entities":[]}。
2. value 保持原文写法，不要翻译、不要改写。
3. 最多抽取 20 个实体；同类型同值不要重复。
4. entities 中每一项都必须同时包含 type 和 value。

${INJECTION_GUARD}`;

/** 统一把用户输入包成一条消息，和 Day 3 的模板使用同一套包裹规则。 */
export function buildStructuredUserMessage(text: string): string {
  const safeInput = text.replace(/<\/user_input>/gi, '&lt;/user_input&gt;');
  return `${USER_INPUT_OPEN}\n${safeInput}\n${USER_INPUT_CLOSE}`;
}
