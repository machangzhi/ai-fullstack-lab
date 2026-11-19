/**
 * 文件作用：验证流式传输、SSE 解析、空响应与客户端中断。
 *
 * 传输层用 fake fetch 返回一段 SSE 报文，不访问真实模型；
 * 服务层用假 transport，重点确认事件顺序、meta 收尾和中断后不再抛错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const OpenAI = require('openai');
const { AppError } = require('../dist/common/errors/app-error.js');
const { AiService } = require('../dist/modules/ai/ai.service.js');
const { OpenAiChatTransport: Transport } = require('../dist/modules/ai/openai-chat.transport.js');

const DEEPSEEK_ENV = {
  MODEL_PROVIDER: 'deepseek',
  MODEL_API_KEY: 'test-deepseek-key',
  MODEL_TEMPERATURE: '0.2',
  MODEL_MAX_TOKENS: '128',
  MODEL_TIMEOUT_MS: '1000',
};

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function deltaChunk(content) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'deepseek-chat',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

const USAGE_CHUNK = `data: ${JSON.stringify({
  id: 'chatcmpl-stream',
  object: 'chat.completion.chunk',
  created: 1_700_000_000,
  model: 'deepseek-chat',
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
})}\n\n`;

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

test('传输层解析 SSE 增量并以 meta 收尾', async () => {
  // Arrange
  let requestBody;
  const fakeFetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return sseResponse([deltaChunk('你'), deltaChunk('好'), USAGE_CHUNK, 'data: [DONE]\n\n']);
  };
  const transport = new Transport(DEEPSEEK_ENV, fakeFetch);

  // Act
  const events = await collect(transport.stream([{ role: 'user', content: '你好' }]));

  // Assert
  assert.equal(requestBody.stream, true);
  assert.deepEqual(requestBody.stream_options, { include_usage: true });
  assert.deepEqual(events, [
    { type: 'delta', content: '你' },
    { type: 'delta', content: '好' },
    {
      type: 'meta',
      model: 'deepseek-chat',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    },
  ]);
});

test('服务层按模板产出 delta，并在最后返回 meta', async () => {
  // Arrange
  const transport = {
    async complete() {
      throw new Error('不应调用非流式方法');
    },
    async *stream(messages, options) {
      assert.equal(messages[0].role, 'system');
      assert.ok(messages[0].content.includes('客服助手'));
      assert.ok(messages[1].content.includes('白屏'));
      assert.ok(options?.signal);
      yield { type: 'delta', content: '建议' };
      yield { type: 'delta', content: '先清缓存' };
      yield { type: 'meta', model: 'deepseek-chat', usage: null };
    },
  };
  const service = new AiService(transport);
  const controller = new AbortController();

  // Act
  const events = await collect(service.streamChat('课程白屏', 'support', controller.signal));

  // Assert
  assert.deepEqual(events, [
    { type: 'delta', content: '建议' },
    { type: 'delta', content: '先清缓存' },
    { type: 'meta', model: 'deepseek-chat', template: 'support', usage: null },
  ]);
});

test('流没有任何内容时返回 AI_EMPTY_RESPONSE', async () => {
  // Arrange
  const transport = {
    async complete() {
      throw new Error('不应调用');
    },
    async *stream() {
      yield { type: 'meta', model: 'deepseek-chat', usage: null };
    },
  };
  const service = new AiService(transport);

  // Act & Assert
  await assert.rejects(collect(service.streamChat('你好')), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'AI_EMPTY_RESPONSE');
    return true;
  });
});

test('客户端中断后生成器正常结束，不抛错也不发 meta', async () => {
  // Arrange
  const controller = new AbortController();
  const transport = {
    async complete() {
      throw new Error('不应调用');
    },
    async *stream() {
      yield { type: 'delta', content: '第一段' };
      controller.abort();
      throw new OpenAI.APIUserAbortError();
    },
  };
  const service = new AiService(transport);

  // Act
  const events = await collect(service.streamChat('你好', 'assistant', controller.signal));

  // Assert
  assert.deepEqual(events, [{ type: 'delta', content: '第一段' }]);
});

test('流式路径同样安全映射供应商超时', async () => {
  // Arrange
  const transport = {
    async complete() {
      throw new Error('不应调用');
    },
    async *stream() {
      throw new OpenAI.APIConnectionTimeoutError();
    },
  };
  const service = new AiService(transport);

  // Act & Assert
  await assert.rejects(collect(service.streamChat('你好')), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'AI_TIMEOUT');
    assert.equal(error.status, 504);
    return true;
  });
});
