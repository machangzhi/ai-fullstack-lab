/**
 * 文件作用：结构化任务的 system 提示词。
 *
 * 与 Day 3 的模板一样，用户输入被 <user_input> 包裹，并附带注入防护规则。
 * 区别是这里的输出要求必须与 Zod schema 完全一致——提示词和 schema 是同一份契约的
 * 两种表达，改任何一边都要同步另一边，否则模型会稳定地「合格地失败」。
 */

import { INJECTION_GUARD, USER_INPUT_CLOSE, USER_INPUT_OPEN } from '../prompts/templates';
import { ENTITY_TYPES } from './parse';

export const CLASSIFY_SYSTEM_PROMPT = `你是用户反馈分类器，只输出一个 JSON 对象。

判定顺序（从上到下，命中即停止）：
1. 提到退款、退货、客服处理进度、维修 → 售后服务
2. 提到发货、快递、配送时效、包裹破损 → 物流配送
3. 提到登录、密码、验证码、账号封禁、支付、扣款 → 账号与支付
4. 提到商品本身的质量、功能、损坏 → 产品质量
5. 以上都不明确，或信息不足以判断 → 其他

置信度标准：
- 0.90-1.00：关键词与类别直接对应
- 0.60-0.89：存在歧义，但有明显倾向
- 0.00-0.59：信息不足，应选「其他」

输出格式：只输出一个 JSON 对象，不要 Markdown 代码块、注释或任何解释文字。
{"category":"售后服务","confidence":0.86,"reason":"用户反馈退款申请未处理"}

规则：
1. category 必须是上述类别之一。
2. confidence 是 0 到 1 之间的小数。
3. reason 不超过 40 字，只陈述判断依据，不重复用户原话。
4. 信息不足或只有笼统负面评价（如「东西不太好」）时，category 选「其他」，confidence 低于 0.6。
5. 第一个非空字符必须是 {，最后一个非空字符必须是 }。

示例：
输入：东西不太好，不太满意 → {"category":"其他","confidence":0.35,"reason":"缺少具体问题描述"}
输入：申请退款三天还没到账 → {"category":"售后服务","confidence":0.94,"reason":"退款处理进度问题"}
输入：快递显示已签收但我没收到 → {"category":"物流配送","confidence":0.95,"reason":"快递签收争议"}

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
