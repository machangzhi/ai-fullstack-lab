/**
 * 文件作用：解析错误的稳定分类（Week 5 Day 2）。
 *
 * 上层（API）只需要按 code 映射 HTTP 状态与提示，不依赖底层库的报错文案。
 */

export type DocumentParseErrorCode =
  /** 扩展名与 MIME 都不在支持列表。 */
  | 'UNSUPPORTED_FORMAT'
  /** 文件为空，或解析后没有任何有效文本。 */
  | 'EMPTY_DOCUMENT'
  /** 文件损坏、加密、编码异常等底层解析失败。 */
  | 'PARSE_FAILED';

export class DocumentParseError extends Error {
  constructor(
    public readonly code: DocumentParseErrorCode,
    message: string,
    /** 原始错误，仅用于日志排查，不返回给客户端。 */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DocumentParseError';
  }
}
