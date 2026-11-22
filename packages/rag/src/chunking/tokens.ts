/**
 * 文件作用：Token 估算（Week 5 Day 3）。
 *
 * 为什么不用真正的分词器：
 * - 不同模型的分词器不同，引入 tokenizer 会让 rag 包绑定具体模型；
 * - 当前只需要「预算量级」，误差 20% 以内足够判断上下文是否超限；
 * - Day 4 调 Embedding、Week 6 组装上下文时，可以用真实 usage 校准这个系数。
 *
 * 估算规则：
 * - 中日韩字符：1 字符 ≈ 1 Token；
 * - 中文标点：1 个 ≈ 1 Token；
 * - 拉丁单词：1 词 ≈ 1.3 Token；
 * - 其它符号：1 个 ≈ 0.3 Token。
 */

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_PUNCTUATION = /[，。！？；：、“”‘’（）《》【】…—]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkCount = (text.match(CJK_CHAR) ?? []).length;
  const cjkPunctuationCount = (text.match(CJK_PUNCTUATION) ?? []).length;
  const rest = text.replace(CJK_CHAR, ' ').replace(CJK_PUNCTUATION, ' ');
  const words = rest.split(/\s+/).filter(Boolean).length;
  const latinPunctuation = (rest.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;

  return Math.ceil(cjkCount + cjkPunctuationCount + words * 1.3 + latinPunctuation * 0.3);
}
