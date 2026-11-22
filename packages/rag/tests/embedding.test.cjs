/**
 * 文件作用：验证 Embedding 配置、HTTP 客户端、批处理与相似度（Week 5 Day 4）。
 *
 * 所有用例使用 Mock fetch / Mock client，不访问网络，也不需要真实密钥。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveEmbeddingConfig,
  createEmbeddingClient,
  embedTexts,
  cosineSimilarity,
  EmbeddingError,
} = require('../dist/index.js');

function makeConfig(overrides = {}) {
  return {
    apiKey: 'sk-test-secret',
    baseUrl: 'https://example.com/v1',
    model: 'test-embed',
    dimensions: null,
    batchSize: 16,
    timeoutMs: 5000,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe('Embedding 配置', () => {
  test('只提供密钥时使用默认地址、模型与批量参数', () => {
    const config = resolveEmbeddingConfig({ EMBEDDING_API_KEY: 'sk-test' });

    assert.equal(config.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.model, 'text-embedding-3-small');
    assert.equal(config.dimensions, null);
    assert.equal(config.batchSize, 16);
    assert.equal(config.timeoutMs, 30_000);
  });

  test('自定义地址会去掉末尾斜杠，并解析可选维度', () => {
    const config = resolveEmbeddingConfig({
      EMBEDDING_API_KEY: 'sk-test',
      EMBEDDING_BASE_URL: 'https://example.com/v1///',
      EMBEDDING_MODEL: 'bge-m3',
      EMBEDDING_DIMENSIONS: '1024',
      EMBEDDING_BATCH_SIZE: '8',
      EMBEDDING_TIMEOUT_MS: '10000',
    });

    assert.equal(config.baseUrl, 'https://example.com/v1');
    assert.equal(config.model, 'bge-m3');
    assert.equal(config.dimensions, 1024);
    assert.equal(config.batchSize, 8);
    assert.equal(config.timeoutMs, 10_000);
  });

  test('缺少密钥时返回 INVALID_CONFIG', () => {
    assert.throws(
      () => resolveEmbeddingConfig({}),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_CONFIG',
    );
  });

  test('拒绝非法地址、非 HTTP 协议与携带账号密码的地址', () => {
    const invalid = [
      'not-a-url',
      'ftp://example.com/v1',
      'https://user:pass@example.com/v1',
    ];

    for (const baseUrl of invalid) {
      assert.throws(
        () =>
          resolveEmbeddingConfig({
            EMBEDDING_API_KEY: 'sk-test',
            EMBEDDING_BASE_URL: baseUrl,
          }),
        (error) => error instanceof EmbeddingError && error.code === 'INVALID_CONFIG',
      );
    }
  });

  test('拒绝越界的数值参数', () => {
    const cases = [
      { EMBEDDING_DIMENSIONS: '0' },
      { EMBEDDING_DIMENSIONS: '8193' },
      { EMBEDDING_BATCH_SIZE: '0' },
      { EMBEDDING_BATCH_SIZE: '129' },
      { EMBEDDING_TIMEOUT_MS: '999' },
      { EMBEDDING_TIMEOUT_MS: '1.5' },
    ];

    for (const overrides of cases) {
      assert.throws(
        () => resolveEmbeddingConfig({ EMBEDDING_API_KEY: 'sk-test', ...overrides }),
        (error) => error instanceof EmbeddingError && error.code === 'INVALID_CONFIG',
      );
    }
  });

  test('错误信息不泄露密钥', () => {
    const apiKey = 'sk-super-secret-value';
    assert.throws(
      () =>
        resolveEmbeddingConfig({
          EMBEDDING_API_KEY: apiKey,
          EMBEDDING_BASE_URL: 'ftp://example.com',
        }),
      (error) => error instanceof Error && !error.message.includes(apiKey),
    );
  });
});

describe('Embedding HTTP 客户端', () => {
  test('发送 OpenAI 兼容请求，并按 index 还原顺序', async () => {
    // Arrange
    let captured;
    const times = [1000, 1250];
    const client = createEmbeddingClient(makeConfig(), {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({
          model: 'test-embed',
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
      now: () => times.shift() ?? 1250,
    });

    // Act
    const result = await client.embed(['first', 'second']);

    // Assert
    assert.equal(captured.url, 'https://example.com/v1/embeddings');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-test-secret');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'test-embed');
    assert.deepEqual(body.input, ['first', 'second']);
    assert.equal('dimensions' in body, false);

    assert.deepEqual(result.embeddings, [
      [1, 2],
      [3, 4],
    ]);
    assert.deepEqual(result.usage, { promptTokens: 5, totalTokens: 5 });
    assert.equal(result.latencyMs, 250);
  });

  test('配置了维度时随请求发送 dimensions', async () => {
    let captured;
    const client = createEmbeddingClient(makeConfig({ dimensions: 512 }), {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse({
          data: [{ index: 0, embedding: [1, 2, 3] }],
        });
      },
    });

    await client.embed(['text']);

    assert.equal(JSON.parse(captured.init.body).dimensions, 512);
  });

  test('HTTP 错误映射为 HTTP_ERROR，且不泄露密钥', async () => {
    const client = createEmbeddingClient(makeConfig(), {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"invalid api key"}}',
      }),
    });

    await assert.rejects(
      () => client.embed(['text']),
      (error) =>
        error instanceof EmbeddingError &&
        error.code === 'HTTP_ERROR' &&
        error.message.includes('401') &&
        !error.message.includes('sk-test-secret'),
    );
  });

  test('非 JSON 响应映射为 INVALID_RESPONSE', async () => {
    const client = createEmbeddingClient(makeConfig(), {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
    });

    await assert.rejects(
      () => client.embed(['text']),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_RESPONSE',
    );
  });

  test('返回数量不匹配或向量非数值时失败', async () => {
    const countClient = createEmbeddingClient(makeConfig(), {
      fetchImpl: async () =>
        jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }),
    });
    await assert.rejects(
      () => countClient.embed(['a', 'b']),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_RESPONSE',
    );

    const valueClient = createEmbeddingClient(makeConfig(), {
      fetchImpl: async () =>
        jsonResponse({ data: [{ index: 0, embedding: [1, 'x'] }] }),
    });
    await assert.rejects(
      () => valueClient.embed(['a']),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_RESPONSE',
    );
  });

  test('网络异常映射为 REQUEST_FAILED', async () => {
    const client = createEmbeddingClient(makeConfig(), {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await assert.rejects(
      () => client.embed(['text']),
      (error) =>
        error instanceof EmbeddingError &&
        error.code === 'REQUEST_FAILED' &&
        error.message.includes('ECONNREFUSED'),
    );
  });
});

describe('批量向量化', () => {
  function createMockClient(options = {}) {
    const calls = [];
    const dimensions = options.dimensions ?? 4;

    return {
      calls,
      async embed(texts) {
        calls.push([...texts]);
        const batchIndex = calls.length - 1;

        return {
          embeddings: texts.map((_text, itemIndex) =>
            Array.from(
              { length: batchIndex === 1 && options.failSecondBatch ? dimensions - 1 : dimensions },
              (_value, dimension) => (batchIndex + itemIndex + dimension) / 10,
            ),
          ),
          model: 'mock-embed',
          usage: { promptTokens: texts.length * 2, totalTokens: texts.length * 2 },
          latencyMs: 10,
        };
      },
    };
  }

  test('100 条文本按 16 条分批，序号与用量正确', async () => {
    // Arrange
    const client = createMockClient();
    const texts = Array.from({ length: 100 }, (_value, index) => `第 ${index} 条知识`);
    const progress = [];

    // Act
    const result = await embedTexts(texts, client, {
      batchSize: 16,
      onBatch: (stats) => progress.push(stats),
    });

    // Assert
    assert.deepEqual(
      client.calls.map((batch) => batch.length),
      [16, 16, 16, 16, 16, 16, 4],
    );
    assert.equal(result.items.length, 100);
    assert.deepEqual(
      result.items.map((item) => item.index),
      Array.from({ length: 100 }, (_value, index) => index),
    );
    assert.equal(result.items[0].text, '第 0 条知识');
    assert.equal(result.dimensions, 4);
    assert.equal(result.model, 'mock-embed');
    assert.deepEqual(result.usage, { promptTokens: 200, totalTokens: 200 });
    assert.equal(result.batches.length, 7);
    assert.equal(result.latencyMs, 70);
    assert.equal(progress.length, 7);
    assert.deepEqual(progress[6], {
      index: 6,
      count: 4,
      latencyMs: 10,
      usage: { promptTokens: 8, totalTokens: 8 },
    });
    assert.ok(result.items.every((item) => item.tokenCount > 0));
  });

  test('空输入、空文本与非法批量大小直接失败', async () => {
    const client = createMockClient();

    await assert.rejects(
      () => embedTexts([], client),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      () => embedTexts(['ok', '   '], client),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      () => embedTexts(['ok'], client, { batchSize: 0 }),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_INPUT',
    );
  });

  test('跨批维度不一致时失败', async () => {
    const client = createMockClient({ failSecondBatch: true });

    await assert.rejects(
      () => embedTexts(['a', 'b', 'c'], client, { batchSize: 2 }),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_RESPONSE',
    );
  });
});

describe('余弦相似度', () => {
  test('同向为 1，正交为 0，反向为 -1', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  test('零向量返回 0，维度不一致抛错', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.throws(
      () => cosineSimilarity([1, 2], [1, 2, 3]),
      (error) => error instanceof EmbeddingError && error.code === 'INVALID_INPUT',
    );
  });
});
