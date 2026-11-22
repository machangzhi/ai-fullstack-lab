/**
 * 文件作用：RAG 文档解析的公共类型（Week 5 Day 2）。
 *
 * 设计原则：
 * 1. 解析结果只描述「文档里有什么」，不做切片、向量化或业务判断。
 * 2. 每个块都保留来源信息（页码、标题路径、顺序），后续切片与引用都依赖它。
 * 3. 不同格式的差异收敛在 ParsedDocument 里，调用方不需要知道 PDF 或 DOCX 细节。
 */

/** 当前支持的文档格式。 */
export type DocumentFormat = 'pdf' | 'docx' | 'txt' | 'markdown';

/** 块类型：标题、普通段落、列表、表格、代码块。 */
export type ParsedBlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'code';

/** 文档中的一个结构化块，是后续切片的输入。 */
export interface ParsedBlock {
  /** 在文档中的顺序，从 0 开始。 */
  index: number;
  type: ParsedBlockType;
  /** 纯文本内容，已去掉 Markdown/HTML 标记。 */
  text: string;
  /** PDF 页码，从 1 开始；其它格式为 null。 */
  page: number | null;
  /** 标题层级：1 表示一级标题；非标题为 null。 */
  headingLevel: number | null;
  /** 当前块所处的标题路径，例如 ["差旅制度", "住宿标准"]。 */
  sectionPath: string[];
  /** 字符数，用于估算切片长度。 */
  charCount: number;
}

/** 解析后的文档。 */
export interface ParsedDocument {
  format: DocumentFormat;
  /** 原始文件名（保留扩展名）。 */
  filename: string;
  /** 文档标题：优先取文档内标题或文件元数据，最后回退到文件名。 */
  title: string;
  mimeType: string;
  /** 所有块按顺序拼接后的纯文本，便于统计与调试。 */
  text: string;
  blocks: ParsedBlock[];
  /** PDF 页数；其它格式为 null。 */
  pageCount: number | null;
  blockCount: number;
  charCount: number;
  /** 解析器提取到的来源元数据（PDF Info、文本编码等），值统一为字符串。 */
  metadata: Record<string, string>;
  /** 解析过程中的非致命问题，例如未闭合代码块、PDF 页数不一致。 */
  warnings: string[];
}

/** parseDocument 的输入。 */
export interface ParseDocumentInput {
  filename: string;
  buffer: Buffer;
  /** 可选 MIME；扩展名无法识别时用它兜底。 */
  mimeType?: string;
}
