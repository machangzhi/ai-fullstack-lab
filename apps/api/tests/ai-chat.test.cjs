const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const OpenAI = require('openai');
const { validate } = require('class-validator');
const { AppError } = require('../dist/common/errors/app-error.js');
const { AiService } = require('../dist/modules/ai/ai.service.js');
const { ChatRequestDto } = require('../dist/modules/ai/dto/chat.dto.js');
const {
  ChatConfigurationError,
  EmptyChatResponseError,
  OpenAiChatTransport,
} = require('../dist/modules/ai/openai-chat.transport.js');

const FAKE_KEY = 'test-deepseek-key';
const DEEPSEEK_ENV = {
  MODEL_PROVIDER: 'deepseek',
  MODEL_API_KEY: FAKE_KEY,
  MODEL_TEMPERATURE: '0.2',
  MODEL_MAX_TOKENS: '128',
  MODEL_TIMEOUT_MS: '1000',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completionBody(overrides = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '这是模拟回复。' },
      },
    ],
    usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
    ...overrides,
  };
}

async function validateMessage(message, template) {
  const dto = new ChatRequestDto();
  dto.message = message;
  if (template !== undefined) {
    dto.template = template;
  }
  return validate(dto);
}

test('DTO 接受合法用户消息', async () => {
  // Arrange & Act
  const errors = await validateMessage('什么是 Chat Completions？');

  // Assert
  assert.equal(errors.length, 0);
});

test('DTO 接受已登记的模板 ID，拒绝未知模板', async () => {
  // Arrange & Act
  const accepted = await validateMessage('退款还没到账', 'support');
  const rejected = await validateMessage('退款还没到账', 'root-admin');

  // Assert
  assert.equal(accepted.length, 0);
  assert.ok(rejected.length > 0);
});

test('DTO 拒绝空白、超长和非字符串消息', async () => {
  // Arrange
  const invalidMessages = ['   \n', 'a'.repeat(8001), 42];

  // Act & Assert
  for (const message of invalidMessages) {
    const errors = await validateMessage(message);
    assert.ok(errors.length > 0);
  }
});

test('Service 组装 system/user 并映射回复、模型和用量', async () => {
  // Arrange
  let receivedMessages;
  const transport = {
    async complete(messages) {
      receivedMessages = messages;
      return {
        content: '上下文窗口是单次请求可处理的 Token 上限。',
        model: 'deepseek-chat',
        usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
      };
    },
  };
  const service = new AiService(transport);

  // Act
  const result = await service.chat('  什么是上下文窗口？  ');

  // Assert
  assert.equal(receivedMessages.length, 2);
  assert.equal(receivedMessages[0].role, 'system');
  assert.ok(receivedMessages[0].content.length > 0);
  assert.equal(receivedMessages[1].role, 'user');
  assert.ok(receivedMessages[1].content.startsWith('<user_input>'));
  assert.ok(receivedMessages[1].content.includes('什么是上下文窗口？'));
  assert.deepEqual(result, {
    reply: '上下文窗口是单次请求可处理的 Token 上限。',
    model: 'deepseek-chat',
    usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
    template: 'assistant',
  });
});

test('Service 按所选模板组装 system，且客户端无法提交提示词原文', async () => {
  // Arrange
  let receivedMessages;
  const transport = {
    async complete(messages) {
      receivedMessages = messages;
      return { content: '建议先排除缓存问题。', model: 'deepseek-chat', usage: null };
    },
  };
  const service = new AiService(transport);

  // Act
  const result = await service.chat('我买的课一直白屏', 'support');

  // Assert
  assert.ok(receivedMessages[0].content.includes('客服助手'));
  assert.ok(receivedMessages[0].content.includes('需要转人工'));
  assert.equal(result.template, 'support');
});

test('Transport 请求 DeepSeek 官方端点并携带配置与 Bearer 密钥', async () => {
  // Arrange
  let capturedUrl;
  let capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse(completionBody());
  };
  const transport = new OpenAiChatTransport(DEEPSEEK_ENV, fakeFetch);

  // Act
  const result = await transport.complete([
    { role: 'system', content: '简洁回答' },
    { role: 'user', content: '你好' },
  ]);

  // Assert
  assert.equal(capturedUrl, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(new Headers(capturedInit.headers).get('authorization'), `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 128);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [
    { role: 'system', content: '简洁回答' },
    { role: 'user', content: '你好' },
  ]);
  assert.deepEqual(result, {
    content: '这是模拟回复。',
    model: 'deepseek-chat',
    usage: { promptTokens: 18, completionTokens: 6, totalTokens: 24 },
  });
});

test('Transport 兼容供应商未返回 usage 的响应', async () => {
  // Arrange
  const fakeFetch = async () => jsonResponse(completionBody({ usage: undefined }));
  const transport = new OpenAiChatTransport(DEEPSEEK_ENV, fakeFetch);

  // Act
  const result = await transport.complete([{ role: 'user', content: '你好' }]);

  // Assert
  assert.equal(result.usage, null);
});

test('Transport 拒绝空回复', async () => {
  // Arrange
  const body = completionBody();
  body.choices[0].message.content = '   ';
  const transport = new OpenAiChatTransport(DEEPSEEK_ENV, async () => jsonResponse(body));

  // Act & Assert
  await assert.rejects(
    transport.complete([{ role: 'user', content: '你好' }]),
    EmptyChatResponseError,
  );
});

test('缺失密钥时返回配置错误且不发起请求', async () => {
  // Arrange
  let requested = false;
  const transport = new OpenAiChatTransport({ MODEL_PROVIDER: 'deepseek' }, async () => {
    requested = true;
    return jsonResponse(completionBody());
  });

  // Act & Assert
  await assert.rejects(
    transport.complete([{ role: 'user', content: '你好' }]),
    ChatConfigurationError,
  );
  assert.equal(requested, false);
});

const errorCases = [
  {
    name: '配置不可用',
    error: new ChatConfigurationError(),
    status: 503,
    code: 'AI_CONFIG_ERROR',
  },
  {
    name: '调用超时',
    error: new OpenAI.APIConnectionTimeoutError(),
    status: 504,
    code: 'AI_TIMEOUT',
  },
  {
    name: '网络断开',
    error: new OpenAI.APIConnectionError({ message: 'raw network detail' }),
    status: 503,
    code: 'AI_UNAVAILABLE',
  },
  {
    name: '供应商认证失败',
    error: new OpenAI.APIError(401, { message: FAKE_KEY }, FAKE_KEY, new Headers()),
    status: 502,
    code: 'AI_PROVIDER_AUTH',
  },
  {
    name: '供应商限流',
    error: new OpenAI.APIError(429, { message: 'too many requests' }, undefined, new Headers()),
    status: 429,
    code: 'RATE_LIMITED',
  },
  {
    name: '空回复',
    error: new EmptyChatResponseError(),
    status: 502,
    code: 'AI_EMPTY_RESPONSE',
  },
  {
    name: '未知供应商异常',
    error: new Error(`raw provider detail: ${FAKE_KEY}`),
    status: 502,
    code: 'AI_PROVIDER_ERROR',
  },
];

for (const item of errorCases) {
  test(`Service 安全映射${item.name}`, async () => {
    // Arrange
    const service = new AiService({
      async complete() {
        throw item.error;
      },
    });

    // Act & Assert
    await assert.rejects(service.chat('你好'), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, item.status);
      assert.equal(error.code, item.code);
      assert.ok(!error.message.includes(FAKE_KEY));
      assert.ok(!error.message.includes('raw provider detail'));
      return true;
    });
  });
}
