/**
 * 文件作用：两种切片策略的实现（Week 5 Day 3）。
 *
 * recursive：把整篇文档拼成连续文本，按分隔符递归切分，适合 PDF / TXT。
 * markdown：先按标题分节，再在节内递归切分；每个 chunk 都带上标题路径，
 *           适合 Markdown / DOCX，检索命中后即使脱离上下文也能看懂主题。
 */

import type { ParsedBlock, ParsedDocument } from '../types';
import { buildDocumentText, mapRangeToSource, splitTextIntoRanges } from './split';
import { estimateTokens } from './tokens';
import type { ChunkOptions, ChunkingResult, ChunkStrategy, DocumentChunk } from './types';

const DEFAULT_CHUNK_SIZE = 600;
const DEFAULT_OVERLAP = 80;
/** 标题路径过长时，正文至少保留的字符数。 */
const MIN_CONTENT_SIZE = 50;

export function chunkDocument(
  document: ParsedDocument,
  options: ChunkOptions = {},
): ChunkingResult {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  validateOptions(chunkSize, overlap);

  const strategy = options.strategy ?? defaultStrategy(document);
  return strategy === 'markdown'
    ? chunkMarkdown(document, chunkSize, overlap)
    : chunkRecursive(document, chunkSize, overlap);
}

function validateOptions(chunkSize: number, overlap: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('chunkSize 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new RangeError('overlap 必须是 >= 0 且小于 chunkSize 的整数');
  }
}

function defaultStrategy(document: ParsedDocument): ChunkStrategy {
  return document.format === 'markdown' || document.format === 'docx' ? 'markdown' : 'recursive';
}

function chunkRecursive(
  document: ParsedDocument,
  chunkSize: number,
  overlap: number,
): ChunkingResult {
  const { text, spans } = buildDocumentText(document.blocks);
  const warnings: string[] = [];

  if (!text.trim()) {
    return { chunks: [], strategy: 'recursive', warnings: ['文档没有可切片的文本'] };
  }

  const chunks: DocumentChunk[] = [];
  for (const range of splitTextIntoRanges(text, chunkSize, overlap)) {
    const content = text.slice(range.start, range.end).trim();
    if (!content) continue;
    const source = mapRangeToSource(range, spans);
    chunks.push({
      index: chunks.length,
      text: content,
      charCount: content.length,
      tokenCount: estimateTokens(content),
      page: source.page,
      pageEnd: source.pageEnd,
      sectionPath: source.sectionPath,
      blockIndexes: source.blockIndexes,
    });
  }

  if (chunks.length === 0) warnings.push('文档没有可切片的文本');
  return { chunks, strategy: 'recursive', warnings };
}

interface Section {
  /** 展示在每个 chunk 前面的标题路径，例如 "差旅制度 > 住宿标准"。 */
  prefix: string;
  headingBlock: ParsedBlock | null;
  contentBlocks: ParsedBlock[];
  sectionPath: string[];
}

function buildSections(blocks: ParsedBlock[]): Section[] {
  const sections: Section[] = [];
  let current: Section = {
    prefix: '',
    headingBlock: null,
    contentBlocks: [],
    sectionPath: [],
  };

  const flush = (): void => {
    if (current.contentBlocks.length > 0) sections.push(current);
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      flush();
      const path = [...block.sectionPath, block.text];
      current = {
        prefix: path.join(' > '),
        headingBlock: block,
        contentBlocks: [],
        sectionPath: path,
      };
    } else {
      current.contentBlocks.push(block);
    }
  }

  flush();
  return sections;
}

function chunkMarkdown(
  document: ParsedDocument,
  chunkSize: number,
  overlap: number,
): ChunkingResult {
  const sections = buildSections(document.blocks);
  const chunks: DocumentChunk[] = [];
  const warnings: string[] = [];
  let prefixWarningAdded = false;

  for (const section of sections) {
    const prefixText = section.prefix ? `${section.prefix}\n\n` : '';
    const available = chunkSize - prefixText.length;

    if (available < MIN_CONTENT_SIZE && !prefixWarningAdded) {
      warnings.push(
        `标题路径占用 ${prefixText.length} 字符，正文按最小 ${MIN_CONTENT_SIZE} 字符切片，chunk 可能超过 chunkSize`,
      );
      prefixWarningAdded = true;
    }

    const contentSize = Math.max(MIN_CONTENT_SIZE, available);
    const { text, spans } = buildDocumentText(section.contentBlocks);

    for (const range of splitTextIntoRanges(text, contentSize, overlap)) {
      const content = text.slice(range.start, range.end).trim();
      if (!content) continue;

      const chunkText = prefixText ? `${section.prefix}\n\n${content}` : content;
      const source = mapRangeToSource(range, spans);
      const headingIndex = section.headingBlock ? [section.headingBlock.index] : [];
      const blockIndexes = [...new Set([...headingIndex, ...source.blockIndexes])].sort(
        (left, right) => left - right,
      );

      chunks.push({
        index: chunks.length,
        text: chunkText,
        charCount: chunkText.length,
        tokenCount: estimateTokens(chunkText),
        page: source.page ?? section.headingBlock?.page ?? null,
        pageEnd: source.pageEnd ?? section.headingBlock?.page ?? null,
        sectionPath:
          section.sectionPath.length > 0 ? [...section.sectionPath] : [...source.sectionPath],
        blockIndexes,
      });
    }
  }

  if (chunks.length === 0) warnings.push('文档没有可切片的正文');
  return { chunks, strategy: 'markdown', warnings };
}
