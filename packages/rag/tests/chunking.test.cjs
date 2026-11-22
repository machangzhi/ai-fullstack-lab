/**
 * 文件作用：验证切片大小、重叠、来源映射与标题策略（Week 5 Day 3）。
 *
 * 测试直接构造 ParsedDocument，不依赖解析器与网络。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { chunkDocument, estimateTokens, parseDocument } = require('../dist/index.js');

function block(index, text, options = {}) {
  return {
    index,
    type: options.type ?? 'paragraph',
    text,
    page: options.page ?? null,
    headingLevel: options.headingLevel ?? null,
    sectionPath: options.sectionPath ?? [],
    charCount: text.length,
  };
}

function makeDoc(blocks, format = 'txt', pageCount = null) {
  const text = blocks.map((item) => item.text).join('\n\n');
  return {
    format,
    filename: `test.${format === 'markdown' ? 'md' : format}`,
    title: '测试文档',
    mimeType: 'text/plain',
    text,
    blocks,
    pageCount,
    blockCount: blocks.length,
    charCount: text.length,
    metadata: {},
    warnings: [],
  };
}

describe('递归切片', () => {
  test('chunk 不超过上限，并保留页码与来源块', () => {
    // Arrange
    const doc = makeDoc(
      [
        block(0, '第一段：' + '差旅制度说明。'.repeat(12), {
          page: 1,
          sectionPath: ['差旅制度'],
        }),
        block(1, '第二段：' + '报销需要发票。'.repeat(12), {
          page: 2,
          sectionPath: ['差旅制度'],
        }),
      ],
      'pdf',
      2,
    );

    // Act
    const result = chunkDocument(doc, { strategy: 'recursive', chunkSize: 100, overlap: 20 });

    // Assert
    assert.equal(result.strategy, 'recursive');
    assert.ok(result.chunks.length > 1);
    for (const chunk of result.chunks) {
      assert.ok(chunk.charCount <= 100, `chunk ${chunk.index} 长度 ${chunk.charCount}`);
      assert.ok(chunk.tokenCount > 0);
      assert.ok(chunk.blockIndexes.length > 0);
      assert.deepEqual(
        chunk.blockIndexes,
        [...chunk.blockIndexes].sort((left, right) => left - right),
      );
      if (chunk.page !== null) {
        assert.ok([1, 2].includes(chunk.page));
        assert.ok(chunk.pageEnd !== null && chunk.pageEnd >= chunk.page);
      }
    }

    const pages = new Set(result.chunks.map((chunk) => chunk.page));
    assert.ok(pages.has(1));
    assert.ok(pages.has(2));
  });

  test('相邻 chunk 在上限内保留重叠窗口', () => {
    // Arrange
    const doc = makeDoc([
      block(0, '第一句内容比较短。第二句内容比较短。第三句内容比较短。第四句内容比较短。第五句内容比较短。'),
    ]);

    // Act
    const result = chunkDocument(doc, { strategy: 'recursive', chunkSize: 40, overlap: 15 });

    // Assert
    assert.ok(result.chunks.length >= 2);
    const firstTail = result.chunks[0].text.slice(-15);
    assert.ok(
      result.chunks[1].text.startsWith(firstTail),
      `第二个 chunk 未保留重叠：${result.chunks[1].text}`,
    );
  });

  test('没有任何分隔符时按字符硬切', () => {
    // Arrange
    const doc = makeDoc([block(0, 'x'.repeat(250))]);

    // Act
    const result = chunkDocument(doc, { strategy: 'recursive', chunkSize: 100, overlap: 0 });

    // Assert
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.charCount),
      [100, 100, 50],
    );
  });
});

describe('Markdown 按标题切片', () => {
  const blocks = [
    block(0, '差旅制度', { type: 'heading', headingLevel: 1 }),
    block(1, '报销说明：' + '需要发票。'.repeat(20), { sectionPath: ['差旅制度'] }),
    block(2, '住宿标准', { type: 'heading', headingLevel: 2, sectionPath: ['差旅制度'] }),
    block(3, '住宿说明：' + '一线城市六百元。'.repeat(20), {
      sectionPath: ['差旅制度', '住宿标准'],
    }),
  ];

  test('每个 chunk 都带上标题路径，且不跨标题混内容', () => {
    // Act
    const result = chunkDocument(makeDoc(blocks, 'markdown'), { chunkSize: 80, overlap: 10 });

    // Assert
    assert.equal(result.strategy, 'markdown');
    assert.ok(result.chunks.length >= 2);

    const firstSection = result.chunks.filter((chunk) => chunk.sectionPath.length === 1);
    const secondSection = result.chunks.filter((chunk) => chunk.sectionPath.length === 2);

    assert.ok(firstSection.length > 0);
    assert.ok(secondSection.length > 0);

    for (const chunk of result.chunks) {
      assert.ok(chunk.charCount <= 80, `chunk ${chunk.index} 长度 ${chunk.charCount}`);
    }

    for (const chunk of firstSection) {
      assert.ok(chunk.text.startsWith('差旅制度\n\n'));
      assert.ok(!chunk.text.includes('住宿说明'));
      assert.ok(chunk.blockIndexes.includes(0));
    }
    assert.ok(firstSection[0].text.includes('报销说明'));

    for (const chunk of secondSection) {
      assert.ok(chunk.text.startsWith('差旅制度 > 住宿标准\n\n'));
      assert.equal(chunk.sectionPath[0], '差旅制度');
      assert.equal(chunk.sectionPath[1], '住宿标准');
      assert.ok(!chunk.text.includes('报销说明'));
      assert.ok(chunk.blockIndexes.includes(2));
    }
    assert.ok(secondSection[0].text.includes('住宿说明'));
  });

  test('只有标题没有正文时返回空列表并给出警告', () => {
    // Act
    const result = chunkDocument(
      makeDoc([block(0, '空章节', { type: 'heading', headingLevel: 1 })], 'markdown'),
    );

    // Assert
    assert.deepEqual(result.chunks, []);
    assert.ok(result.warnings.some((warning) => warning.includes('没有可切片的正文')));
  });
});

describe('策略选择与参数校验', () => {
  test('默认策略由文档格式决定', () => {
    const markdownDoc = makeDoc([block(0, '# 标题')], 'markdown');
    const pdfDoc = makeDoc([block(0, '正文')], 'pdf');

    assert.equal(chunkDocument(markdownDoc).strategy, 'markdown');
    assert.equal(chunkDocument(pdfDoc).strategy, 'recursive');
    assert.equal(chunkDocument(pdfDoc, { strategy: 'markdown' }).strategy, 'markdown');
  });

  test('非法参数抛出 RangeError', () => {
    const doc = makeDoc([block(0, '正文')]);

    assert.throws(() => chunkDocument(doc, { chunkSize: 0 }), RangeError);
    assert.throws(() => chunkDocument(doc, { chunkSize: 100, overlap: 100 }), RangeError);
    assert.throws(() => chunkDocument(doc, { chunkSize: 100, overlap: -1 }), RangeError);
  });
});

describe('Token 估算', () => {
  test('中日韩字符与标点按 1 Token 估算', () => {
    assert.equal(estimateTokens('你好世界'), 4);
    assert.equal(estimateTokens('你好，世界。'), 6);
  });

  test('英文按单词估算，符号权重更低', () => {
    assert.equal(estimateTokens('hello world'), 3);
  });

  test('空文本为 0', () => {
    assert.equal(estimateTokens(''), 0);
  });
});

describe('解析到切片', () => {
  test('Markdown 解析结果可以直接进入默认切片流程', async () => {
    // Arrange
    const markdown = [
      '# 差旅制度',
      '',
      '报销需要发票。'.repeat(120),
      '',
      '## 住宿标准',
      '',
      '一线城市六百元。'.repeat(120),
    ].join('\n');
    const document = await parseDocument({
      filename: 'handbook.md',
      buffer: Buffer.from(markdown, 'utf8'),
    });

    // Act
    const result = chunkDocument(document);

    // Assert
    assert.ok(result.chunks.length > 2);
    assert.ok(result.chunks.every((chunk) => chunk.text.length > 0));
    assert.ok(result.chunks.every((chunk) => chunk.blockIndexes.length > 0));
    assert.ok(
      result.chunks.some((chunk) => chunk.sectionPath.join('/') === '差旅制度/住宿标准'),
    );
  });
});
