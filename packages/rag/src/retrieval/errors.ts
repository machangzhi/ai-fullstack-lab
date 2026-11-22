/**
 * 文件作用：检索策略的稳定错误分类（Week 6 Day 1）。
 *
 * 检索参数来自 API 或实验脚本，错误必须能被调用方区分：
 * 是用户传错了参数，还是索引/数据本身有问题。
 */

export type RetrievalErrorCode = 'INVALID_INPUT';

export class RetrievalError extends Error {
  constructor(
    public readonly code: RetrievalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RetrievalError';
  }
}
