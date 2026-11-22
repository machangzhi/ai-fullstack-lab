/**
 * 文件作用：验证向量库写入事务、参数校验与 Top-K SQL（Week 5 Day 5）。
 *
 * 这里用 Fake Prisma 捕获 SQL 对象，不连接数据库；
 * 真实 pgvector 的执行验证放在文档的「手工验证」步骤中。
 */

require('reflect-metadata');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { VectorStoreService } = require('../dist/modules/knowledge/vector-store.service.js');
const { VECTOR_DIMENSION } = require('../dist/modules/knowledge/vector-store.types.js');
const { VectorStoreError } = require('../dist/modules/knowledge/vector-store.errors.js');

function makeVector(marker = 0, dimension = VECTOR_DIMENSION) {
  return Array.from({ length: dimension }, (_value, index) => (index === marker ? 1 : 0));
}

function makeChunk(overrides = {}) {
  return {
    index: 0,
    text: '一线城市住宿标准为每晚六百元。',
    page: null,
    pageEnd: null,
    sectionPath: ['差旅制度', '住宿标准'],
    blockIndexes: [1, 2],
    tokenCount: 18,
    embedding: makeVector(0),
    ...overrides,
  };
}

function makeDocumentInput(overrides = {}) {
  return {
    title: '差旅制度',
    filename: 'travel.md',
    mimeType: 'text/markdown',
    format: 'markdown',
    charCount: 1200,
    blockCount: 3,
    metadata: { source: 'test' },
    chunks: [makeChunk()],
    ...overrides,
  };
}

function createFakePrisma(options = {}) {
  const state = { transactions: 0, created: [], inserts: [], queries: [] };

  const tx = {
    document: {
      async create({ data }) {
        state.created.push(data);
        return { id: 'doc-1', ...data };
      },
    },
    async $executeRaw(query) {
      state.inserts.push(query);
      return 1;
    },
  };

  return {
    state,
    async $transaction(callback) {
      state.transactions += 1;
      if (options.transactionError) throw options.transactionError;
      return callback(tx);
    },
    async $queryRaw(query) {
      state.queries.push(query);
      if (options.queryError) throw options.queryError;
      return options.rows ?? [];
    },
  };
}

describe('写入文档与切片', () => {
  test('同一事务内创建文档，并逐条写入向量', async () => {
    // Arrange
    const prisma = createFakePrisma();
    const service = new VectorStoreService(prisma);

    // Act
    const result = await service.createDocumentWithChunks(makeDocumentInput());

    // Assert
    assert.deepEqual(result, { documentId: 'doc-1', chunkCount: 1 });
    assert.equal(prisma.state.transactions, 1);
    assert.equal(prisma.state.created.length, 1);
    assert.equal(prisma.state.created[0].status, 'READY');
    assert.deepEqual(prisma.state.created[0].metadata, { source: 'test' });

    assert.equal(prisma.state.inserts.length, 1);
    const insert = prisma.state.inserts[0];
    assert.match(insert.text, /INSERT INTO "document_chunks"/);
    assert.match(insert.text, /::vector/);
    assert.ok(insert.values.includes('["差旅制度","住宿标准"]'));
    assert.ok(insert.values.includes('[1,2]'));
    assert.ok(
      insert.values.some(
        (value) => typeof value === 'string' && value.startsWith('[') && value.endsWith(']'),
      ),
    );
  });

  test('允许写入 PENDING 文档，供后续异步向量化', async () => {
    const prisma = createFakePrisma();
    const service = new VectorStoreService(prisma);

    await service.createDocumentWithChunks(makeDocumentInput({ status: 'PENDING' }));

    assert.equal(prisma.state.created[0].status, 'PENDING');
  });

  test('空切片、重复序号与错误维度都不会进入事务', async () => {
    const cases = [
      makeDocumentInput({ chunks: [] }),
      makeDocumentInput({
        chunks: [makeChunk({ index: 0 }), makeChunk({ index: 0 })],
      }),
      makeDocumentInput({ chunks: [makeChunk({ embedding: [1, 2, 3] })] }),
      makeDocumentInput({ chunks: [makeChunk({ embedding: [Number.NaN, ...makeVector(0).slice(1)] })] }),
    ];

    for (const input of cases) {
      const prisma = createFakePrisma();
      const service = new VectorStoreService(prisma);

      await assert.rejects(
        () => service.createDocumentWithChunks(input),
        (error) => error instanceof VectorStoreError,
      );
      assert.equal(prisma.state.transactions, 0);
    }
  });

  test('数据库异常被包装为 DB_ERROR，且不暴露底层信息', async () => {
    const prisma = createFakePrisma({ transactionError: new Error('connection lost') });
    const service = new VectorStoreService(prisma);

    await assert.rejects(
      () => service.createDocumentWithChunks(makeDocumentInput()),
      (error) =>
        error instanceof VectorStoreError &&
        error.code === 'DB_ERROR' &&
        error.message === '写入向量库失败' &&
        !error.message.includes('connection lost'),
    );
  });
});

describe('Top-K 相似度检索', () => {
  test('构造参数化 SQL，并映射 jsonb 与 similarity', async () => {
    // Arrange
    const rows = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: '差旅制度',
        filename: 'travel.md',
        format: 'markdown',
        chunkIndex: 2,
        content: '一线城市住宿标准为每晚六百元。',
        page: 3,
        pageEnd: 4,
        sectionPath: ['差旅制度', '住宿标准'],
        blockIndexes: [5],
        tokenCount: 18,
        similarity: '0.87',
      },
    ];
    const prisma = createFakePrisma({ rows });
    const service = new VectorStoreService(prisma);

    // Act
    const hits = await service.searchSimilar({
      embedding: makeVector(0),
      topK: 3,
      documentId: 'doc-1',
      minSimilarity: 0.5,
    });

    // Assert
    assert.deepEqual(hits, [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: '差旅制度',
        filename: 'travel.md',
        format: 'markdown',
        chunkIndex: 2,
        content: '一线城市住宿标准为每晚六百元。',
        page: 3,
        pageEnd: 4,
        sectionPath: ['差旅制度', '住宿标准'],
        blockIndexes: [5],
        tokenCount: 18,
        similarity: 0.87,
      },
    ]);

    const query = prisma.state.queries[0];
    assert.match(query.text, /ORDER BY dc\."embedding" <=> \$/);
    assert.match(query.text, /LIMIT \$/);
    assert.ok(query.values.includes('doc-1'));
    assert.ok(query.values.includes(3));
    assert.ok(query.values.includes(0.5));
    assert.ok(
      query.values.some(
        (value) => typeof value === 'string' && value.startsWith('[') && value.endsWith(']'),
      ),
    );
  });

  test('jsonb 以字符串返回时也能还原为数组', async () => {
    const prisma = createFakePrisma({
      rows: [
        {
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          documentTitle: '制度',
          filename: 'doc.md',
          format: 'markdown',
          chunkIndex: 0,
          content: '内容',
          page: null,
          pageEnd: null,
          sectionPath: '["制度"]',
          blockIndexes: '[0,1]',
          tokenCount: 2,
          similarity: 0.5,
        },
      ],
    });
    const service = new VectorStoreService(prisma);

    const [hit] = await service.searchSimilar({ embedding: makeVector(0) });

    assert.deepEqual(hit.sectionPath, ['制度']);
    assert.deepEqual(hit.blockIndexes, [0, 1]);
    assert.equal(hit.similarity, 0.5);
  });

  test('文档、格式、章节与 metadata 过滤都进入参数化 SQL', async () => {
    const prisma = createFakePrisma();
    const service = new VectorStoreService(prisma);

    await service.searchSimilar({
      embedding: makeVector(0),
      filters: {
        documentIds: ['doc-1', 'doc-2'],
        formats: ['pdf', 'markdown'],
        filenameContains: '差旅%',
        titleContains: '制度',
        sectionPathPrefix: ['差旅制度', '住宿标准'],
        metadata: { source: 'pdf-info' },
      },
    });

    const query = prisma.state.queries[0];
    assert.match(query.text, /d\."id" IN \(/);
    assert.match(query.text, /d\."format" IN \(/);
    assert.match(query.text, /d\."filename" ILIKE \$\d+ ESCAPE/);
    assert.match(query.text, /d\."title" ILIKE \$\d+ ESCAPE/);
    assert.match(query.text, /dc\."sectionPath"->>\$\d+::int = \$\d+/);
    assert.match(query.text, /d\."metadata" @> \$\d+::jsonb/);
    assert.match(query.text, /ORDER BY dc\."embedding" <=> \$/);

    assert.ok(query.values.includes('doc-1'));
    assert.ok(query.values.includes('pdf'));
    assert.ok(query.values.includes('markdown'));
    assert.ok(query.values.includes('%差旅\\%%'));
    assert.ok(query.values.includes('%制度%'));
    assert.ok(query.values.includes('差旅制度'));
    assert.ok(query.values.includes('住宿标准'));
    assert.ok(query.values.includes('{"source":"pdf-info"}'));
  });

  test('过滤参数非法时直接失败，不执行查询', async () => {
    const cases = [
      { filters: { documentIds: [] } },
      { filters: { documentIds: ['   '] } },
      { filters: { formats: ['exe'] } },
      { filters: { formats: [] } },
      { filters: { filenameContains: '   ' } },
      { filters: { sectionPathPrefix: [''] } },
      { filters: { metadata: {} } },
      { filters: { metadata: { source: null } } },
      { filters: [] },
    ];

    for (const input of cases) {
      const prisma = createFakePrisma();
      const service = new VectorStoreService(prisma);

      await assert.rejects(
        () => service.searchSimilar({ embedding: makeVector(0), ...input }),
        (error) => error instanceof VectorStoreError && error.code === 'INVALID_INPUT',
        `应拒绝：${JSON.stringify(input)}`,
      );
      assert.equal(prisma.state.queries.length, 0);
    }
  });

  test('topK、minSimilarity 与 documentId 非法时直接失败', async () => {
    const cases = [
      { embedding: makeVector(0), topK: 0 },
      { embedding: makeVector(0), topK: 51 },
      { embedding: makeVector(0), topK: 1.5 },
      { embedding: makeVector(0), minSimilarity: -0.1 },
      { embedding: makeVector(0), minSimilarity: 1.1 },
      { embedding: makeVector(0), documentId: '   ' },
      { embedding: [1, 2, 3], topK: 5 },
    ];

    for (const input of cases) {
      const prisma = createFakePrisma();
      const service = new VectorStoreService(prisma);

      await assert.rejects(
        () => service.searchSimilar(input),
        (error) => error instanceof VectorStoreError,
      );
      assert.equal(prisma.state.queries.length, 0);
    }
  });

  test('查询异常被包装为 DB_ERROR', async () => {
    const prisma = createFakePrisma({ queryError: new Error('timeout') });
    const service = new VectorStoreService(prisma);

    await assert.rejects(
      () => service.searchSimilar({ embedding: makeVector(0) }),
      (error) =>
        error instanceof VectorStoreError &&
        error.code === 'DB_ERROR' &&
        error.message === '向量检索失败',
    );
  });
});
