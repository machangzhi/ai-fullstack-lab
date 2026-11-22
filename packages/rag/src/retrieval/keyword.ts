/**
 * 文件作用：轻量关键词打分（Week 6 Day 1）。
 *
 * 为什么需要关键词检索：
 * - 向量召回擅长语义相近，但对编号、专有名词、精确短语不敏感；
 * - 混合检索先用关键词补足「字面命中」，再由向量负责语义泛化；
 * - 生产环境通常用 BM25 / Elasticsearch / PostgreSQL 全文索引，
 *   这里实现一个可离线运行、可解释的覆盖率打分，用于原型与对比实验。
 *
 * 中文没有空格，采用「汉字二元组」切分：
 *   "住宿标准" → ["住宿", "宿标", "标准"]
 * 英文/数字按连续字母数字切分并转小写。
 *
 * 这不是生产级分词：不处理同义词、停用词和词频饱和；
 * 但足够说明混合检索的融合方式，并且结果可重复、可测试。
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const ASCII_TERM = /[a-z0-9]+(?:[._-][a-z0-9]+)*/gi;

export function tokenizeForKeyword(text: string): string[] {
  if (!text) return [];

  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  for (const run of normalized.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }

  for (const term of normalized.match(ASCII_TERM) ?? []) {
    if (term.length >= 2 || /^\d+$/.test(term)) tokens.push(term);
  }

  return tokens;
}

/**
 * 关键词覆盖率：查询词中有多少比例出现在片段里。
 *
 * 返回 0~1：
 * - 0 表示没有任何查询词命中；
 * - 1 表示查询中的所有词都出现在片段中。
 */
export function keywordScore(query: string, content: string): number {
  const queryTokens = [...new Set(tokenizeForKeyword(query))];
  if (queryTokens.length === 0) return 0;

  const contentTokens = new Set(tokenizeForKeyword(content));
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched += 1;
  }

  return matched / queryTokens.length;
}
