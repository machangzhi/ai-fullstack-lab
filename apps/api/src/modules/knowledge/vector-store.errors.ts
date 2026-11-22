/**
 * 文件作用：向量库的稳定错误分类（Week 5 Day 5）。
 *
 * 与 Embedding 错误分开：这里的失败发生在「写库 / 检索」阶段，
 * 上层可以据此判断是用户输入问题、维度配置问题还是数据库问题。
 */

export type VectorStoreErrorCode = 'INVALID_INPUT' | 'INVALID_VECTOR' | 'DB_ERROR';

export class VectorStoreError extends Error {
  constructor(
    public readonly code: VectorStoreErrorCode,
    message: string,
    /** 原始数据库异常，仅用于日志。 */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VectorStoreError';
  }
}
