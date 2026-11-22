/**
 * 文件作用：RAG 包的公共出口（Week 5 Day 2）。
 *
 * 目前只包含文档解析；切片（Day 3）、Embedding（Day 4）与检索（Day 5）
 * 会继续在这个包里扩展，API 统一从这里引用。
 */

export { DocumentParseError } from './errors';
export type { DocumentParseErrorCode } from './errors';
export { parseDocument } from './parse-document';
export type {
  DocumentFormat,
  ParsedBlock,
  ParsedBlockType,
  ParsedDocument,
  ParseDocumentInput,
} from './types';
