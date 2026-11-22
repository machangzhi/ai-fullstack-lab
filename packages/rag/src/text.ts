/**
 * 文件作用：文本解码与通用块构造（Week 5 Day 2）。
 *
 * TXT/Markdown 没有声明编码，上传来源可能是 UTF-8（带或不带 BOM），也可能是
 * Windows 下常见的 GB18030。这里先按 UTF-8 解码，出现替换字符再回退 GB18030。
 */

import type { ParsedBlock, ParsedBlockType } from './types';

export interface DecodedText {
  text: string;
  encoding: 'utf8' | 'gb18030';
}

/** 解码上传的文本文件，统一换行符并去掉 BOM。 */
export function decodeText(buffer: Buffer): DecodedText {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: normalizeNewlines(buffer.subarray(3).toString('utf8')), encoding: 'utf8' };
  }

  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return { text: normalizeNewlines(utf8), encoding: 'utf8' };
  }

  try {
    const gb18030 = new TextDecoder('gb18030').decode(buffer);
    return { text: normalizeNewlines(gb18030), encoding: 'gb18030' };
  } catch {
    // 运行环境不支持 GB18030 时保留 UTF-8 结果，替换字符会体现在正文里。
    return { text: normalizeNewlines(utf8), encoding: 'utf8' };
  }
}

export function normalizeNewlines(text: string): string {
  // 用 split/join 去掉 NUL，避免正则里的控制字符触发 no-control-regex。
  return text.replace(/\r\n?/g, '\n').split('\u0000').join('');
}

/** 构造一个块；空文本返回 null，避免产生无意义的空块。 */
export function makeBlock(
  index: number,
  type: ParsedBlockType,
  text: string,
  options: { page?: number | null; headingLevel?: number | null; sectionPath?: string[] } = {},
): ParsedBlock | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return {
    index,
    type,
    text: trimmed,
    page: options.page ?? null,
    headingLevel: options.headingLevel ?? null,
    sectionPath: options.sectionPath ?? [],
    charCount: trimmed.length,
  };
}

/** 合并段落中被硬换行拆开的行；保留原始换行以便调试。 */
export function joinLines(lines: string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join('\n');
}
