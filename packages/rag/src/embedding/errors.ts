/**
 * 文件作用：Embedding 调用的稳定错误分类（Week 5 Day 4）。
 *
 * 上层不需要解析供应商的错误文案，只按 code 决定重试、降级或提示。
 */

export type EmbeddingErrorCode =
  /** 环境变量缺失或取值非法。 */
  | 'INVALID_CONFIG'
  /** 输入为空、包含空文本或向量维度不一致。 */
  | 'INVALID_INPUT'
  /** 网络断开、超时等请求未完成。 */
  | 'REQUEST_FAILED'
  /** 服务返回非 2xx。 */
  | 'HTTP_ERROR'
  /** 响应结构不符合 OpenAI Embeddings 协议。 */
  | 'INVALID_RESPONSE';

export class EmbeddingError extends Error {
  constructor(
    public readonly code: EmbeddingErrorCode,
    message: string,
    /** 原始错误或响应片段，仅用于日志，不包含密钥。 */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}
