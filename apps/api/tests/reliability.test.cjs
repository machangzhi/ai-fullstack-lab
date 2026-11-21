/**
 * 文件作用：模型调用可靠性测试（Week 4 Day 4）。
 *
 * 覆盖四类基础件与两条集成路径：
 * 1. 退避算法与信号量（纯函数/纯内存）；
 * 2. 熔断器状态机（注入时钟，不依赖真实等待）；
 * 3. ReliableChatTransport：超时、有限重试、并发限制、熔断快速失败；
 * 4. AiService 把可靠性错误映射为统一业务错误码。
 *
 * 全部测试不访问网络、不写数据库，使用假 Transport 与假计时。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const OpenAI = require('openai');
const { AppError } = require('../dist/common/errors/app-error.js');
const { AiService } = require('../dist/modules/ai/ai.service.js');
const { CircuitBreaker } = require('../dist/modules/ai/reliability/circuit-breaker.js');
const { Semaphore } = require('../dist/modules/ai/reliability/semaphore.js');
const { computeBackoffMs } = require('../dist/modules/ai/reliability/retry.js');
const {
  ReliableChatTransport,
} = require('../dist/modules/ai/reliability/reliable-chat.transport.js');
const {
  AiCallTimeoutError,
  AiCircuitOpenError,
  AiConcurrencyLimitError,
} = require('../dist/modules/ai/reliability/reliability-errors.js');

function fakeResult(content = 'ok') {
  return { content, model: 'fake-model', profileId: 'fake', usage: null };
}

function createTransport(handler) {
  const calls = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      return handler(messages, options, calls.length);
    },
    async completeWithTools() {
      throw new Error('completeWithTools should not be called in this test');
    },
    async *stream() {
      throw new Error('stream should not be called in this test');
    },
    listModels() {
      return { defaultId: 'fake', models: [] };
    },
    getModelLimits() {
      return { contextWindow: 1000, maxOutputTokens: 100 };
    },
  };
}

function providerError(status) {
  return new OpenAI.APIError(
    status,
    { message: 'upstream detail' },
    'upstream detail',
    new Headers(),
  );
}

test('退避时间随尝试次数指数增长，并带有 50%~100% 抖动', () => {
  // Arrange & Act & Assert
  assert.equal(
    computeBackoffMs(1, 200, 2000, () => 0),
    100,
  );
  assert.equal(
    computeBackoffMs(1, 200, 2000, () => 1),
    200,
  );
  assert.equal(
    computeBackoffMs(2, 200, 2000, () => 0),
    200,
  );
  assert.equal(
    computeBackoffMs(10, 200, 2000, () => 1),
    2000,
  );
});

test('信号量在容量内直接放行，释放后把槽位转交给等待者', async () => {
  // Arrange
  const semaphore = new Semaphore(1);

  // Act
  const releaseFirst = await semaphore.acquire(50);
  const waiting = semaphore.acquire(200);
  assert.equal(semaphore.activeCount, 1);
  assert.equal(semaphore.queueLength, 1);

  releaseFirst();
  const releaseSecond = await waiting;

  // Assert
  assert.equal(semaphore.activeCount, 1);
  assert.equal(semaphore.queueLength, 0);
  releaseSecond();
  assert.equal(semaphore.activeCount, 0);
});

test('信号量排队超时抛出并发限制错误', async () => {
  // Arrange
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(10);

  // Act & Assert
  await assert.rejects(semaphore.acquire(20), (error) => {
    assert.ok(error instanceof AiConcurrencyLimitError);
    return true;
  });
  release();
});

test('5xx 失败按退避重试，成功后返回结果', async () => {
  // Arrange
  let attempts = 0;
  const inner = createTransport(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw providerError(500);
    }
    return fakeResult('第三次成功');
  });
  const transport = new ReliableChatTransport(inner, {
    maxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 1,
  });

  // Act
  const result = await transport.complete([{ role: 'user', content: '你好' }]);

  // Assert
  assert.equal(result.content, '第三次成功');
  assert.equal(inner.calls.length, 3);
});

test('400 等不可重试错误只调用一次，不放大费用', async () => {
  // Arrange
  const inner = createTransport(async () => {
    throw providerError(400);
  });
  const transport = new ReliableChatTransport(inner, {
    maxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 1,
  });

  // Act & Assert
  await assert.rejects(transport.complete([{ role: 'user', content: '你好' }]), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(inner.calls.length, 1);
});

test('单次尝试超时会主动取消上游并抛 AiCallTimeoutError', async () => {
  // Arrange
  let aborted = false;
  const inner = createTransport(
    (_messages, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  );
  const transport = new ReliableChatTransport(inner, {
    maxAttempts: 1,
    callTimeoutMs: 20,
  });

  // Act & Assert
  await assert.rejects(transport.complete([{ role: 'user', content: '你好' }]), (error) => {
    assert.ok(error instanceof AiCallTimeoutError);
    return true;
  });
  assert.equal(aborted, true);
  assert.equal(inner.calls.length, 1);
});

test('并发槽位被占满时，排队超时返回并发限制错误', async () => {
  // Arrange
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const inner = createTransport(async () => {
    await firstDone;
    return fakeResult();
  });
  const transport = new ReliableChatTransport(inner, {
    maxConcurrency: 1,
    queueTimeoutMs: 20,
  });

  // Act
  const first = transport.complete([{ role: 'user', content: '第一个' }]);
  await assert.rejects(
    transport.complete([{ role: 'user', content: '第二个' }]),
    (error) => error instanceof AiConcurrencyLimitError,
  );
  releaseFirst();
  await first;

  // Assert
  assert.equal(inner.calls.length, 1);
});

test('熔断器打开后快速失败，冷却后只放行一个探测请求', () => {
  // Arrange
  let now = 0;
  const breaker = new CircuitBreaker(2, 1000, () => now);

  // Act：连续两次失败后打开
  assert.equal(breaker.tryAcquire(), true);
  breaker.onFailure();
  assert.equal(breaker.tryAcquire(), true);
  breaker.onFailure();

  // Assert
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.tryAcquire(), false);

  // 冷却结束：只允许一个探测请求
  now = 1000;
  assert.equal(breaker.tryAcquire(), true);
  assert.equal(breaker.snapshot().state, 'half-open');
  assert.equal(breaker.tryAcquire(), false);

  breaker.onSuccess();
  assert.equal(breaker.snapshot().state, 'closed');
});

test('连续失败触发熔断后不再调用上游，恢复后重新放行', async () => {
  // Arrange
  let calls = 0;
  const inner = createTransport(async () => {
    calls += 1;
    throw providerError(503);
  });
  const transport = new ReliableChatTransport(inner, {
    maxAttempts: 1,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 20,
  });

  // Act：两次逻辑失败打开熔断
  await assert.rejects(transport.complete([{ role: 'user', content: '一' }]));
  await assert.rejects(transport.complete([{ role: 'user', content: '二' }]));
  await assert.rejects(
    transport.complete([{ role: 'user', content: '三' }]),
    (error) => error instanceof AiCircuitOpenError,
  );

  // Assert：第三次没有真正发起上游调用
  assert.equal(calls, 2);
});

test('流式调用失败同样触发熔断，后续请求快速失败', async () => {
  // Arrange：只实现 stream，complete 用来验证熔断打开后根本不会调用上游。
  const transport = new ReliableChatTransport(
    {
      async complete() {
        throw new Error('complete should not be called while circuit is open');
      },
      async completeWithTools() {
        throw new Error('completeWithTools should not be called');
      },
      async *stream() {
        throw providerError(503);
      },
      listModels() {
        return { defaultId: 'fake', models: [] };
      },
      getModelLimits() {
        return { contextWindow: 1000, maxOutputTokens: 100 };
      },
    },
    { circuitFailureThreshold: 1, circuitCooldownMs: 1000 },
  );

  // Act & Assert：第一次流式失败
  await assert.rejects(
    (async () => {
      for await (const _event of transport.stream([{ role: 'user', content: '你好' }])) {
        // 本用例不关心增量内容
      }
    })(),
    (error) => error.status === 503,
  );

  // 第二次请求在进入上游前就被熔断拦截
  await assert.rejects(
    transport.complete([{ role: 'user', content: '再试一次' }]),
    (error) => error instanceof AiCircuitOpenError,
  );
});

test('环境变量缺省时回退默认参数，不影响正常调用', async () => {
  // Arrange
  const inner = createTransport(async () => fakeResult('默认配置可用'));
  const transport = ReliableChatTransport.fromEnv(inner, {});

  // Act
  const result = await transport.complete([{ role: 'user', content: '你好' }]);

  // Assert
  assert.equal(result.content, '默认配置可用');
  assert.equal(inner.calls.length, 1);
});

test('AiService 把可靠性错误映射为统一错误码', async () => {
  // Arrange
  const cases = [
    { error: new AiCallTimeoutError(), code: 'AI_TIMEOUT', status: 504 },
    { error: new AiConcurrencyLimitError(), code: 'AI_CONCURRENCY_LIMIT', status: 503 },
    { error: new AiCircuitOpenError(), code: 'AI_CIRCUIT_OPEN', status: 503 },
  ];

  for (const item of cases) {
    const service = new AiService({
      async complete() {
        throw item.error;
      },
    });

    // Act & Assert
    await assert.rejects(service.chat('你好'), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, item.code);
      assert.equal(error.status, item.status);
      assert.ok(!error.message.includes('upstream detail'));
      return true;
    });
  }
});
