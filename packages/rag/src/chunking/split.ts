/**
 * 文件作用：范围切片与来源映射（Week 5 Day 3）。
 *
 * 关键设计：切片器返回的是原文上的 [start, end) 范围，而不是新的字符串。
 * 有了范围，才能准确回答「这个 chunk 覆盖了哪些块、哪几页」，
 * 引用与调试都依赖这份映射。
 */

import type { ParsedBlock } from '../types';

export interface TextRange {
  start: number;
  end: number;
}

export interface SourceSpan {
  start: number;
  end: number;
  block: ParsedBlock;
}

export interface SourceInfo {
  page: number | null;
  pageEnd: number | null;
  sectionPath: string[];
  blockIndexes: number[];
}

/**
 * 分隔符从粗到细：
 * 段落 → 行 → 中文句末 → 中文停顿 → 空格 → 硬切。
 * 先尝试保住语义边界，实在放不下才按字符切。
 */
const DEFAULT_SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '，', ' ', ''];

export function splitTextIntoRanges(
  text: string,
  chunkSize: number,
  overlap: number,
  separators: string[] = DEFAULT_SEPARATORS,
): TextRange[] {
  if (!text.trim()) return [];

  const fragments = splitRecursive(text, { start: 0, end: text.length }, chunkSize, separators);
  return mergeRanges(text, fragments, chunkSize, overlap);
}

function splitRecursive(
  text: string,
  range: TextRange,
  chunkSize: number,
  separators: string[],
): TextRange[] {
  if (range.end - range.start <= chunkSize) return [range];
  if (separators.length === 0) return hardSplit(range, chunkSize);

  const [separator, ...rest] = separators;
  if (!separator) return hardSplit(range, chunkSize);

  const pieces = splitAtSeparator(text, range, separator);
  if (pieces.length <= 1) return splitRecursive(text, range, chunkSize, rest);

  return pieces.flatMap((piece) =>
    piece.end - piece.start <= chunkSize
      ? [piece]
      : splitRecursive(text, piece, chunkSize, rest),
  );
}

/** 在范围内按分隔符切开，分隔符保留在前一段末尾，避免句子被拆掉标点。 */
function splitAtSeparator(text: string, range: TextRange, separator: string): TextRange[] {
  const pieces: TextRange[] = [];
  let cursor = range.start;

  while (cursor < range.end) {
    const found = text.indexOf(separator, cursor);
    if (found === -1 || found >= range.end) {
      pieces.push({ start: cursor, end: range.end });
      break;
    }

    const end = Math.min(found + separator.length, range.end);
    pieces.push({ start: cursor, end });
    cursor = end;
  }

  return pieces;
}

function hardSplit(range: TextRange, chunkSize: number): TextRange[] {
  const pieces: TextRange[] = [];
  for (let start = range.start; start < range.end; start += chunkSize) {
    pieces.push({ start, end: Math.min(start + chunkSize, range.end) });
  }
  return pieces;
}

/**
 * 把小片段合并成不超过 chunkSize 的窗口。
 *
 * 重叠只在上一个 chunk 的尾部取，且只有「重叠 + 新片段」仍放得下时才加，
 * 因此不会为了重叠而超出大小上限。
 */
function mergeRanges(
  text: string,
  fragments: TextRange[],
  chunkSize: number,
  overlap: number,
): TextRange[] {
  const chunks: TextRange[] = [];
  let current: TextRange | null = null;

  for (const fragment of fragments) {
    if (!current) {
      current = { ...fragment };
      continue;
    }

    if (fragment.end - current.start <= chunkSize) {
      current.end = fragment.end;
      continue;
    }

    chunks.push(current);

    const overlapStart = Math.max(current.start, current.end - overlap);
    const withOverlap = fragment.end - overlapStart;
    current =
      overlap > 0 && withOverlap <= chunkSize
        ? { start: overlapStart, end: fragment.end }
        : { start: fragment.start, end: fragment.end };
  }

  if (current) chunks.push(current);

  return chunks.filter((range) => text.slice(range.start, range.end).trim().length > 0);
}

/** 把块列表拼成连续文本，同时记录每块在文本中的范围。 */
export function buildDocumentText(blocks: ParsedBlock[]): { text: string; spans: SourceSpan[] } {
  let text = '';
  const spans: SourceSpan[] = [];

  blocks.forEach((block, index) => {
    if (index > 0) text += '\n\n';
    const start = text.length;
    text += block.text;
    spans.push({ start, end: text.length, block });
  });

  return { text, spans };
}

/** 找出与 chunk 范围相交的块，汇总页码与标题路径。 */
export function mapRangeToSource(range: TextRange, spans: SourceSpan[]): SourceInfo {
  const overlapping = spans.filter(
    (span) => span.start < range.end && span.end > range.start,
  );

  const pages = overlapping
    .map((span) => span.block.page)
    .filter((page): page is number => page !== null);

  return {
    page: pages.length > 0 ? Math.min(...pages) : null,
    pageEnd: pages.length > 0 ? Math.max(...pages) : null,
    sectionPath: overlapping[0] ? [...overlapping[0].block.sectionPath] : [],
    blockIndexes: [...new Set(overlapping.map((span) => span.block.index))],
  };
}
