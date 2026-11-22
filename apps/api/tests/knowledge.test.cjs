/**
 * 文件作用：验证知识库 ingestion 与检索编排（Week 5 Day 6）。
 *
 * 全部使用 Mock Embedding 与 Mock 向量库，不访问网络、不连接数据库。
 */

require('reflect-metadata');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('class-validator');
const { EmbeddingError } = require('@ai-lab/rag');
const { KnowledgeService } = require('../dist/modules/knowledge/knowledge.service.js');
const {
  SearchKnowledgeDto,
} = require('../dist/modules/knowledge/dto/search-knowledge.dto.js');
const {
  VECTOR_DIMENSION,
} = require('../dist/modules/knowledge/vector-store.types.js');
const {
  VectorStoreError,
} = require('../dist/modules/knowledge/vector-store.errors.js');

const MARKDOWN = `# 差旅制度

## 住宿标准

一线城市住宿标准为每晚六百元，二线城市为每晚四百元，其他城市为三百元。
${'出差住宿需要提供酒店发票，发票抬头必须与公司名称一致。'.repeat(20)}

## 报销流程

出差结束后五个工作日内提交报销单，并附上出差申请编号和所有发票原件。
${'报销金额超过五千元需要财务经理审批，电子发票需上传 PDF 原件。'.repeat(20)}
`;

function makeFile(overrides = {}) {
  return {
    originalname: 'travel.md',
    mimetype: 'text/markdown',
    buffer: Buffer.from(MARKDOWN),
    size: Buffer.byteLength(MARKDOWN),
    ...overrides,
  };
}

function makeEmbeddingResult(texts, dimension = VECTOR_DIMENSION) {
  return {
    items: texts.map((text, index) => ({
      index,
      text,
      vector: Array.from({ length: dimension }, (_value, position) =>
        position === index ? 1 : 0,
      ),
      tokenCount: 1,
    })),
    model: 'mock-embed',
    dimensions: dimension,
    batches: [],
    usage: { promptTokens: texts.length * 2, totalTokens: texts.length * 2 },
    latencyMs: 1,
  };
}

function createGateway(options = {}) {
  return {
    calls: [],
    async embed(texts) {
      this.calls.push(texts);
      if (options.error) throw options.error;
      return makeEmbeddingResult(texts, options.dimension ?? VECTOR_DIMENSION);
    },
  };
}

function createStore(options = {}) {
  return {
    ingestCalls: [],
    searchCalls: [],
    async createDocumentWithChunks(input) {
      this.ingestCalls.push(input);
      if (options.error) throw options.error;
      return { documentId: 'doc-1', chunkCount: input.chunks.length };
    },
    async searchSimilar(input) {
      this.searchCalls.push(input);
      if (options.error) throw options.error;
      return options.hits ?? [];
    },
  };
}

describe('知识库 ingestion', () => {
  test('解析 Markdown、切片、向量化并写入 READY 文档', async () => {
    // Arrange
    const store = createStore();
    const gateway = createGateway();
    const service = new KnowledgeService(store, gateway);

    // Act
    const result = await service.ingest(makeFile());

    // Assert
    assert.equal(result.documentId, 'doc-1');
    assert.equal(result.title, '差旅制度');
    assert.equal(result.format, 'markdown');
    assert.equal(result.status, 'READY');
    assert.ok(result.chunkCount >= 2);
    assert.equal(result.chunkStrategy, 'markdown');
    assert.equal(result.embeddingModel, 'mock-embed');
    assert.equal(result.dimensions, VECTOR_DIMENSION);
    assert.equal(result.usage.totalTokens, result.chunkCount * 2);
    assert.ok(result.metrics.totalMs >= 0);

    assert.equal(store.ingestCalls.length, 1);
    const stored = store.ingestCalls[0];
    assert.equal(stored.status, 'READY');
    assert.equal(stored.format, 'markdown');
    assert.equal(stored.chunks.length, result.chunkCount);
    assert.equal(stored.chunks[0].embedding.length, VECTOR_DIMENSION);
    assert.ok(Array.isArray(stored.chunks[0].sectionPath));
    assert.ok(Array.isArray(stored.chunks[0].blockIndexes));

    assert.equal(gateway.calls.length, 1);
    assert.equal(gateway.calls[0].length, result.chunkCount);
  });

  test('缺少 Embedding 配置时返回 503，且不写库', async () => {
    const store = createStore();
    const gateway = createGateway({
      error: new EmbeddingError('INVALID_CONFIG', '缺少 EMBEDDING_API_KEY'),
    });
    const service = new KnowledgeService(store, gateway);

    await assert.rejects(
      () => service.ingest(makeFile()),
      (error) =>
        error.code === 'KNOWLEDGE_EMBEDDING_UNAVAILABLE' &&
        error.status === 503 &&
        !error.message.includes('EMBEDDING_API_KEY='),
    );
    assert.equal(store.ingestCalls.length, 0);
  });

  test('Embedding 调用失败与维度不一致分别映射为 502 / 503', async () => {
    const failed = new KnowledgeService(
      createStore(),
      createGateway({ error: new EmbeddingError('HTTP_ERROR', 'HTTP 500') }),
    );
    await assert.rejects(
      () => failed.ingest(makeFile()),
      (error) => error.code === 'KNOWLEDGE_EMBEDDING_FAILED' && error.status === 502,
    );

    const mismatchedStore = createStore();
    const mismatched = new KnowledgeService(
      mismatchedStore,
      createGateway({ dimension: 3 }),
    );
    await assert.rejects(
      () => mismatched.ingest(makeFile()),
      (error) => error.code === 'KNOWLEDGE_VECTOR_MISMATCH' && error.status === 503,
    );
    assert.equal(mismatchedStore.ingestCalls.length, 0);
  });

  test('空文件与不支持格式在解析前被拒绝', async () => {
    const service = new KnowledgeService(createStore(), createGateway());

    await assert.rejects(
      () => service.ingest(makeFile({ buffer: Buffer.alloc(0), size: 0 })),
      (error) => error.code === 'KNOWLEDGE_EMPTY_FILE' && error.status === 400,
    );

    await assert.rejects(
      () =>
        service.ingest(
          makeFile({
            originalname: 'malware.exe',
            mimetype: 'application/octet-stream',
            buffer: Buffer.from('MZ'),
            size: 2,
          }),
        ),
      (error) => error.code === 'KNOWLEDGE_UNSUPPORTED_FORMAT' && error.status === 400,
    );
  });

  test('向量库异常映射为 503，不泄露底层信息', async () => {
    const store = createStore({
      error: new VectorStoreError('DB_ERROR', 'connection lost'),
    });
    const service = new KnowledgeService(store, createGateway());

    await assert.rejects(
      () => service.ingest(makeFile()),
      (error) =>
        error.code === 'KNOWLEDGE_STORE_UNAVAILABLE' &&
        error.status === 503 &&
        !error.message.includes('connection lost'),
    );
  });
});

describe('知识库检索', () => {
  const hit = {
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    documentTitle: '差旅制度',
    filename: 'travel.md',
    chunkIndex: 0,
    content: '一线城市住宿标准为每晚六百元。',
    page: null,
    pageEnd: null,
    sectionPath: ['差旅制度', '住宿标准'],
    blockIndexes: [0],
    tokenCount: 18,
    similarity: 0.91,
  };

  test('问题向量化后按参数检索，并返回耗时与用量', async () => {
    const store = createStore({ hits: [hit] });
    const gateway = createGateway();
    const service = new KnowledgeService(store, gateway);

    const result = await service.search({
      query: '  住宿标准是多少？  ',
      topK: 3,
      documentId: 'doc-1',
      minSimilarity: 0.5,
    });

    assert.equal(result.query, '住宿标准是多少？');
    assert.deepEqual(result.hits, [hit]);
    assert.equal(result.meta.embeddingModel, 'mock-embed');
    assert.equal(result.meta.dimensions, VECTOR_DIMENSION);
    assert.equal(result.meta.usage.promptTokens, 2);
    assert.ok(result.meta.totalMs >= 0);

    assert.equal(gateway.calls.length, 1);
    assert.deepEqual(gateway.calls[0], ['住宿标准是多少？']);
    assert.equal(store.searchCalls.length, 1);
    assert.equal(store.searchCalls[0].embedding.length, VECTOR_DIMENSION);
    assert.equal(store.searchCalls[0].topK, 3);
    assert.equal(store.searchCalls[0].documentId, 'doc-1');
    assert.equal(store.searchCalls[0].minSimilarity, 0.5);
  });

  test('空问题与维度不一致直接失败', async () => {
    const service = new KnowledgeService(createStore(), createGateway());
    await assert.rejects(
      () => service.search({ query: '   ' }),
      (error) => error.code === 'KNOWLEDGE_INVALID_INPUT' && error.status === 400,
    );

    const mismatched = new KnowledgeService(
      createStore(),
      createGateway({ dimension: 3 }),
    );
    await assert.rejects(
      () => mismatched.search({ query: '住宿' }),
      (error) => error.code === 'KNOWLEDGE_VECTOR_MISMATCH' && error.status === 503,
    );
  });
});

describe('检索 DTO', () => {
  test('合法参数通过，越界参数被拒绝', async () => {
    const valid = Object.assign(new SearchKnowledgeDto(), {
      query: '住宿标准',
      topK: 5,
      minSimilarity: 0.4,
    });
    assert.equal((await validate(valid)).length, 0);

    const invalidCases = [
      { query: '   ' },
      { query: '住宿', topK: 21 },
      { query: '住宿', topK: 0 },
      { query: '住宿', minSimilarity: 1.2 },
      { query: '住宿', documentId: '   ' },
    ];

    for (const input of invalidCases) {
      const dto = Object.assign(new SearchKnowledgeDto(), input);
      const errors = await validate(dto);
      assert.ok(errors.length > 0, `应拒绝：${JSON.stringify(input)}`);
    }
  });
});
