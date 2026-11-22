/**
 * 文件作用：余弦相似度（Week 5 Day 4）。
 *
 * 为什么用余弦而不是欧氏距离：文本 Embedding 通常按方向表达语义，
 * 长度受文本长短影响；余弦只看夹角，对长度不敏感。
 *
 * 约定：零向量与任何向量的相似度返回 0，避免出现 NaN。
 */

import { EmbeddingError } from './errors';

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new EmbeddingError(
      'INVALID_INPUT',
      `向量维度不一致：${left.length} 与 ${right.length}`,
    );
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;

  const similarity = dot / Math.sqrt(leftNorm * rightNorm);
  return Math.max(-1, Math.min(1, similarity));
}
