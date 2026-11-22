/**
 * 文件作用：文档解析入口（Week 5 Day 2）。
 *
 * 负责三件事：
 * 1. 根据扩展名 / MIME 判断格式；
 * 2. 调用对应解析器，把底层异常包装成稳定的 DocumentParseError；
 * 3. 组装 ParsedDocument，保证空文档不会被当成解析成功。
 */

import { DocumentParseError } from './errors';
import { parseDocx, parseMarkdown, parsePdf, parseTxt, fileStem, type ParserOutput } from './parsers';
import type { DocumentFormat, ParsedDocument, ParseDocumentInput } from './types';

interface FormatInfo {
  format: DocumentFormat;
  mimeType: string;
}

const EXTENSION_FORMATS: Record<string, FormatInfo> = {
  '.pdf': { format: 'pdf', mimeType: 'application/pdf' },
  '.docx': {
    format: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  '.txt': { format: 'txt', mimeType: 'text/plain' },
  '.md': { format: 'markdown', mimeType: 'text/markdown' },
  '.markdown': { format: 'markdown', mimeType: 'text/markdown' },
};

const MIME_FORMATS: Record<string, FormatInfo> = {
  'application/pdf': { format: 'pdf', mimeType: 'application/pdf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    format: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  'text/plain': { format: 'txt', mimeType: 'text/plain' },
  'text/markdown': { format: 'markdown', mimeType: 'text/markdown' },
};

function detectFormat(input: ParseDocumentInput): FormatInfo {
  const base = input.filename.replace(/\\/g, '/').split('/').pop() ?? input.filename;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';

  const byExtension = extension ? EXTENSION_FORMATS[extension] : undefined;
  if (byExtension) {
    return {
      format: byExtension.format,
      mimeType: input.mimeType?.trim() || byExtension.mimeType,
    };
  }

  const byMime = input.mimeType ? MIME_FORMATS[input.mimeType.trim().toLowerCase()] : undefined;
  if (byMime) return byMime;

  throw new DocumentParseError(
    'UNSUPPORTED_FORMAT',
    `不支持的文件格式：${extension || input.mimeType || '未知'}。当前支持 PDF、DOCX、TXT、Markdown。`,
  );
}

export async function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
  if (!input.buffer || input.buffer.length === 0) {
    throw new DocumentParseError('EMPTY_DOCUMENT', '文件为空，无法解析。');
  }

  const { format, mimeType } = detectFormat(input);
  let output: ParserOutput;

  try {
    switch (format) {
      case 'txt':
        output = parseTxt(input.buffer);
        break;
      case 'markdown':
        output = parseMarkdown(input.buffer);
        break;
      case 'docx':
        output = await parseDocx(input.buffer);
        break;
      case 'pdf':
        output = await parsePdf(input.buffer);
        break;
    }
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentParseError('PARSE_FAILED', `${format.toUpperCase()} 解析失败：${message}`, error);
  }

  const text = output.blocks.map((block) => block.text).join('\n\n');
  if (!text.trim()) {
    throw new DocumentParseError('EMPTY_DOCUMENT', '文档没有可提取的文本。');
  }

  return {
    format,
    filename: input.filename,
    title: output.title?.trim() || fileStem(input.filename),
    mimeType,
    text,
    blocks: output.blocks,
    pageCount: output.pageCount,
    blockCount: output.blocks.length,
    charCount: text.length,
    metadata: output.metadata,
    warnings: output.warnings,
  };
}
