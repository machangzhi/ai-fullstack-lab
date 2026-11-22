/**
 * 文件作用：四种文档格式的解析实现（Week 5 Day 2）。
 *
 * 共同目标：把不同格式统一成 ParsedBlock 列表，并尽量保留来源结构：
 * - PDF：页码；
 * - DOCX / Markdown：标题层级与标题路径；
 * - TXT：段落顺序（以空行分隔）；
 * - Markdown：列表、表格、代码块类型。
 *
 * 解析只做「提取」，不做切片与向量化；块大小是否合适由 Day 3 的切片器决定。
 */

import * as mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { makeBlock, decodeText, joinLines } from './text';
import type { ParsedBlock } from './types';

/** 各解析器的统一返回值，由 parseDocument 组装成 ParsedDocument。 */
export interface ParserOutput {
  blocks: ParsedBlock[];
  /** 文档内识别出的标题；没有时由调用方回退到文件名。 */
  title?: string;
  pageCount: number | null;
  metadata: Record<string, string>;
  warnings: string[];
}

// pdf-parse 自带的类型较旧，这里只声明实际用到的字段，避免依赖库的内部类型。
interface PdfTextItem {
  str: string;
  transform: number[];
}

interface PdfPageProxy {
  getTextContent(options?: {
    normalizeWhitespace?: boolean;
    disableCombineTextItems?: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
}

interface PdfParseOptions {
  pagerender?: (pageData: PdfPageProxy) => Promise<string>;
}

interface PdfParseResult {
  numpages: number;
  text: string;
  info?: Record<string, unknown>;
}

type PdfParseFn = (data: Buffer, options?: PdfParseOptions) => Promise<PdfParseResult>;

const parsePdfBuffer = pdfParse as unknown as PdfParseFn;

/** 文件名去掉扩展名，作为标题兜底。 */
function fileStem(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** TXT：没有结构信息，以空行分段。 */
export function parseTxt(buffer: Buffer): ParserOutput {
  const { text, encoding } = decodeText(buffer);
  const blocks: ParsedBlock[] = [];

  for (const part of text.split(/\n{2,}/)) {
    const block = makeBlock(blocks.length, 'paragraph', part);
    if (block) blocks.push(block);
  }

  return {
    blocks,
    pageCount: null,
    metadata: { encoding },
    warnings: [],
  };
}

/** Markdown：保留标题层级、列表、表格与代码块。 */
export function parseMarkdown(buffer: Buffer): ParserOutput {
  const { text, encoding } = decodeText(buffer);
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  const warnings: string[] = [];
  const headings: string[] = [];
  let firstHeading = '';
  let title = '';

  let paragraph: string[] = [];
  let list: string[] = [];
  let table: string[] = [];

  const push = (
    type: ParsedBlock['type'],
    content: string,
    options: { headingLevel?: number | null } = {},
  ): void => {
    const block = makeBlock(blocks.length, type, content, {
      headingLevel: options.headingLevel ?? null,
      sectionPath: [...headings],
    });
    if (block) blocks.push(block);
  };

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      push('paragraph', joinLines(paragraph));
      paragraph = [];
    }
  };

  const flushList = (): void => {
    if (list.length > 0) {
      push('list', list.join('\n'));
      list = [];
    }
  };

  const flushTable = (): void => {
    if (table.length > 0) {
      const rows = table.filter((row) => !/^\|?[\s:|-]+\|?$/.test(row));
      if (rows.length > 0) push('table', rows.join('\n'));
      table = [];
    }
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushTable();
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    // 代码块优先判断，避免块内的 # 被当成标题。
    if (/^\s*```/.test(line)) {
      flushAll();
      const codeLines: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        if (/^\s*```/.test(lines[index])) {
          closed = true;
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      if (!closed) warnings.push('Markdown 代码块未闭合');
      push('code', codeLines.join('\n'));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const headingText = heading[2].trim();
      headings.length = level - 1;
      push('heading', headingText, { headingLevel: level });
      headings[level - 1] = headingText;
      if (!firstHeading) firstHeading = headingText;
      if (!title && level === 1) title = headingText;
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushAll();
      index += 1;
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      flushTable();
      list.push(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim());
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushParagraph();
      flushList();
      table.push(line.trim());
      index += 1;
      continue;
    }

    flushList();
    flushTable();
    paragraph.push(line);
    index += 1;
  }

  flushAll();

  return {
    blocks,
    title: title || firstHeading || undefined,
    pageCount: null,
    metadata: { encoding },
    warnings,
  };
}

/** 把 Mammoth 生成的简单 HTML 转成块；表格单元格内的段落会各自成块。 */
function htmlToBlocks(html: string): { blocks: ParsedBlock[]; title?: string } {
  const marked = html
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n@@H${level}@@`)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n@@LI@@')
    .replace(/<\/li>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n@@P@@')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  const decoded = decodeHtmlEntities(marked)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks: ParsedBlock[] = [];
  const headings: string[] = [];
  let title = '';

  let currentType: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'P' | 'LI' | null = null;
  let buffer: string[] = [];

  const push = (type: 'heading' | 'paragraph' | 'list', content: string, level?: number): void => {
    const block = makeBlock(blocks.length, type, content, {
      headingLevel: level ?? null,
      sectionPath: [...headings],
    });
    if (block) blocks.push(block);
  };

  const flush = (): void => {
    if (!currentType) return;
    const content = buffer.join('\n');
    buffer = [];

    if (currentType.startsWith('H')) {
      const level = Number(currentType.slice(1));
      headings.length = level - 1;
      push('heading', content, level);
      headings[level - 1] = content;
      if (!title && level === 1) title = content;
    } else if (currentType === 'LI') {
      push('list', content);
    } else {
      push('paragraph', content);
    }
    currentType = null;
  };

  for (const line of decoded) {
    const marker = line.match(/^@@(H[1-6]|P|LI)@@(.*)$/);
    if (marker) {
      flush();
      currentType = marker[1] as typeof currentType;
      if (marker[2].trim()) buffer.push(marker[2].trim());
      continue;
    }

    if (!currentType) {
      currentType = 'P';
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }
  flush();

  return { blocks, title: title || undefined };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

/** DOCX：用 Mammoth 转 HTML，再提取标题与段落。 */
export async function parseDocx(buffer: Buffer): Promise<ParserOutput> {
  const result = await mammoth.convertToHtml({ buffer });
  const { blocks, title } = htmlToBlocks(result.value);
  const warnings = result.messages
    .slice(0, 10)
    .map((message) => `${message.type}: ${message.message}`);

  return {
    blocks,
    title,
    pageCount: null,
    metadata: {},
    warnings,
  };
}

/** PDF：按页提取文本，块上保留页码。 */
export async function parsePdf(buffer: Buffer): Promise<ParserOutput> {
  const pages: string[] = [];

  const result = await parsePdfBuffer(buffer, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });

      let pageText = '';
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!item.str) continue;
        const y = item.transform[5];
        if (lastY === undefined || Math.abs(y - lastY) <= 1) {
          pageText += item.str;
        } else {
          // 行间距明显变大时视为段落分隔，否则只是换行。
          pageText += Math.abs(y - lastY) > 14 ? '\n\n' : '\n';
          pageText += item.str;
        }
        lastY = y;
      }

      pages.push(pageText);
      return pageText;
    },
  });

  const warnings: string[] = [];
  if (pages.length > 0 && pages.length !== result.numpages) {
    warnings.push(`PDF 页数不一致：元数据 ${result.numpages} 页，实际提取 ${pages.length} 页`);
  }

  const pageTexts = pages.length > 0 ? pages : result.text.split(/\n?\f\n?/);
  const blocks: ParsedBlock[] = [];

  for (let pageIndex = 0; pageIndex < pageTexts.length; pageIndex += 1) {
    for (const part of pageTexts[pageIndex].split(/\n{2,}/)) {
      const block = makeBlock(blocks.length, 'paragraph', part, { page: pageIndex + 1 });
      if (block) blocks.push(block);
    }
  }

  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.info ?? {})) {
    if (typeof value === 'string' && value.trim()) {
      metadata[key] = value.trim();
    }
  }

  return {
    blocks,
    title: metadata.Title,
    pageCount: result.numpages,
    metadata,
    warnings,
  };
}

export { fileStem };
