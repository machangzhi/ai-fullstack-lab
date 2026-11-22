/**
 * 文件作用：验证四种格式的解析结果与来源元数据（Week 5 Day 2）。
 *
 * 测试不访问网络：DOCX / PDF 夹具在内存里生成，TXT / Markdown 直接构造 Buffer。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument, DocumentParseError } = require('../dist/index.js');
const { createDocx } = require('./helpers/make-docx.cjs');
const { createPdf } = require('./helpers/make-pdf.cjs');

describe('TXT 解析', () => {
  test('去除 BOM，按空行分段，标题回退到文件名', async () => {
    // Arrange
    const buffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('第一段内容。\n\n第二段内容。\n'),
    ]);

    // Act
    const doc = await parseDocument({ filename: '差旅制度.txt', buffer, mimeType: 'text/plain' });

    // Assert
    assert.equal(doc.format, 'txt');
    assert.equal(doc.title, '差旅制度');
    assert.equal(doc.blockCount, 2);
    assert.deepEqual(
      doc.blocks.map((block) => block.text),
      ['第一段内容。', '第二段内容。'],
    );
    assert.equal(doc.blocks[0].page, null);
    assert.deepEqual(doc.blocks[0].sectionPath, []);
    assert.equal(doc.metadata.encoding, 'utf8');
  });

  test('空文件返回 EMPTY_DOCUMENT', async () => {
    await assert.rejects(
      () => parseDocument({ filename: 'empty.txt', buffer: Buffer.alloc(0) }),
      (error) => error instanceof DocumentParseError && error.code === 'EMPTY_DOCUMENT',
    );
  });
});

describe('Markdown 解析', () => {
  test('保留标题层级、标题路径、列表、表格与代码块', async () => {
    // Arrange
    const markdown = [
      '# 差旅制度',
      '',
      '公司差旅按本标准执行。',
      '',
      '## 住宿标准',
      '',
      '- 一线城市 600 元',
      '- 其他城市 400 元',
      '',
      '| 城市 | 标准 |',
      '| --- | --- |',
      '| 北京 | 600 |',
      '',
      '```bash',
      'pnpm test',
      '```',
      '',
    ].join('\n');

    // Act
    const doc = await parseDocument({
      filename: 'handbook.md',
      buffer: Buffer.from(markdown, 'utf8'),
    });

    // Assert
    assert.equal(doc.format, 'markdown');
    assert.equal(doc.title, '差旅制度');
    assert.deepEqual(
      doc.blocks.map((block) => block.type),
      ['heading', 'paragraph', 'heading', 'list', 'table', 'code'],
    );
    assert.equal(doc.blocks[0].headingLevel, 1);
    assert.deepEqual(doc.blocks[2].sectionPath, ['差旅制度']);
    assert.equal(doc.blocks[2].headingLevel, 2);
    assert.deepEqual(doc.blocks[3].sectionPath, ['差旅制度', '住宿标准']);
    assert.ok(doc.blocks[3].text.includes('一线城市'));
    assert.ok(doc.blocks[4].text.includes('北京'));
    assert.ok(!doc.blocks[4].text.includes('---'));
    assert.equal(doc.blocks[5].text, 'pnpm test');
    assert.deepEqual(doc.warnings, []);
  });

  test('扩展名缺失时用 MIME 识别 Markdown', async () => {
    // Act
    const doc = await parseDocument({
      filename: 'upload',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 标题\n\n内容', 'utf8'),
    });

    // Assert
    assert.equal(doc.format, 'markdown');
    assert.equal(doc.title, '标题');
  });
});

describe('DOCX 解析', () => {
  test('提取标题、段落与标题路径', async () => {
    // Arrange
    const buffer = await createDocx([
      { text: '差旅制度', style: 'Heading1' },
      { text: '报销需要提供发票。' },
      { text: '住宿标准', style: 'Heading2' },
      { text: '一线城市每晚 600 元。' },
    ]);

    // Act
    const doc = await parseDocument({
      filename: 'policy.docx',
      buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    // Assert
    assert.equal(doc.format, 'docx');
    assert.equal(doc.title, '差旅制度');
    assert.equal(doc.pageCount, null);
    assert.equal(doc.blocks[0].type, 'heading');
    assert.equal(doc.blocks[0].headingLevel, 1);
    assert.deepEqual(doc.blocks[1].sectionPath, ['差旅制度']);
    assert.equal(doc.blocks[2].headingLevel, 2);
    assert.deepEqual(doc.blocks[3].sectionPath, ['差旅制度', '住宿标准']);
  });
});

describe('PDF 解析', () => {
  test('提取多页正文，块上保留页码与 Info 标题', async () => {
    // Arrange
    const buffer = await createPdf(
      [
        ['Travel Policy', 'Receipts are required for all trips.'],
        ['Hotel limit is 600 CNY per night.'],
      ],
      'Travel Policy Fixture',
    );

    // Act
    const doc = await parseDocument({ filename: 'travel.pdf', buffer, mimeType: 'application/pdf' });

    // Assert
    assert.equal(doc.format, 'pdf');
    assert.equal(doc.pageCount, 2);
    assert.equal(doc.title, 'Travel Policy Fixture');
    assert.equal(doc.metadata.Title, 'Travel Policy Fixture');
    assert.deepEqual([...new Set(doc.blocks.map((block) => block.page))], [1, 2]);
    assert.ok(doc.text.includes('Travel Policy'));
    assert.ok(doc.text.includes('Receipts are required'));
    assert.ok(doc.text.includes('Hotel limit is 600 CNY'));
  });
});

describe('错误处理', () => {
  test('不支持的扩展名返回 UNSUPPORTED_FORMAT', async () => {
    await assert.rejects(
      () =>
        parseDocument({
          filename: 'data.csv',
          buffer: Buffer.from('a,b', 'utf8'),
          mimeType: 'text/csv',
        }),
      (error) => error instanceof DocumentParseError && error.code === 'UNSUPPORTED_FORMAT',
    );
  });

  test('损坏的 PDF 返回 PARSE_FAILED', async () => {
    await assert.rejects(
      () => parseDocument({ filename: 'broken.pdf', buffer: Buffer.from('not a pdf') }),
      (error) => error instanceof DocumentParseError && error.code === 'PARSE_FAILED',
    );
  });
});
