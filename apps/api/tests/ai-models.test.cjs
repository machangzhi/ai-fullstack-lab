/**
 * 文件作用：统一 LlmService 测试（Week 4 Day 1）。
 *
 * 不创建真实 OpenAI 客户端：注入假的 createClient，验证档案路由、客户端复用、
 * 未知模型错误与公开目录脱敏。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { AppError } = require('../dist/common/errors/app-error.js');
const { AiService } = require('../dist/modules/ai/ai.service.js');
const { LlmService } = require('../dist/modules/ai/llm.service.js');
const {
  ChatConfigurationError,
  UnknownModelProfileError,
} = require('../dist/modules/ai/openai-chat.transport.js');

const MULTI_ENV = {
  MODEL_PROVIDER: 'deepseek',
  MODEL_API_KEY: 'test-base-key',
  MODEL_PROFILES: 'deepseek-chat,deepseek-reasoner',
  MODEL_DEFAULT_PROFILE: 'deepseek-chat',
  MODEL_PROFILE_DEEPSEEK_CHAT_LABEL: 'DeepSeek Chat',
  MODEL_PROFILE_DEEPSEEK_CHAT_MODEL: 'deepseek-chat',
  MODEL_PROFILE_DEEPSEEK_REASONER_LABEL: 'DeepSeek Reasoner',
  MODEL_PROFILE_DEEPSEEK_REASONER_MODEL: 'deepseek-reasoner',
  MODEL_PROFILE_DEEPSEEK_REASONER_TEMPERATURE: '0.2',
};

function createFakeFactory() {
  const created = [];
  const calls = [];

  const factory = (profile) => {
    created.push(profile.id);
    return {
      async complete(messages, options) {
        calls.push({ profileId: profile.id, messages, options });
        return {
          content: `${profile.id} 的回答`,
          model: profile.model,
          profileId: profile.id,
          usage: null,
        };
      },
      async *stream(messages, options) {
        calls.push({ profileId: profile.id, messages, options });
        yield { type: 'delta', content: profile.id };
        yield { type: 'meta', profileId: profile.id, model: profile.model, usage: null };
      },
    };
  };

  return { factory, created, calls };
}

test('不传档案时路由到默认模型，并复用同一个客户端', async () => {
  // Arrange
  const { factory, created, calls } = createFakeFactory();
  const service = new LlmService(MULTI_ENV, factory);

  // Act
  const first = await service.complete([{ role: 'user', content: '你好' }]);
  const second = await service.complete([{ role: 'user', content: '再来一次' }]);

  // Assert
  assert.equal(first.profileId, 'deepseek-chat');
  assert.equal(second.profileId, 'deepseek-chat');
  assert.deepEqual(created, ['deepseek-chat']);
  assert.equal(calls.length, 2);
});

test('按公开档案 ID 切换到另一个模型', async () => {
  // Arrange
  const { factory, created, calls } = createFakeFactory();
  const service = new LlmService(MULTI_ENV, factory);

  // Act
  const result = await service.complete([{ role: 'user', content: '解释一下推理模型' }], {
    profileId: 'deepseek-reasoner',
  });

  // Assert
  assert.equal(result.profileId, 'deepseek-reasoner');
  assert.equal(result.model, 'deepseek-reasoner');
  assert.deepEqual(created, ['deepseek-reasoner']);
  assert.equal(calls[0].profileId, 'deepseek-reasoner');
});

test('未知档案 ID 抛出可识别的错误，AiService 映射为 400', async () => {
  // Arrange
  const { factory, created } = createFakeFactory();
  const llm = new LlmService(MULTI_ENV, factory);
  const service = new AiService(llm);

  // Act & Assert
  await assert.rejects(
    llm.complete([{ role: 'user', content: '你好' }], { profileId: 'gpt-4o' }),
    UnknownModelProfileError,
  );
  await assert.rejects(service.chat('你好', 'assistant', 'gpt-4o'), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'AI_MODEL_UNKNOWN');
    assert.equal(error.status, 400);
    return true;
  });
  assert.deepEqual(created, []);
});

test('配置缺失时报告配置错误，不创建客户端', async () => {
  // Arrange
  const { factory, created } = createFakeFactory();
  const service = new LlmService({ MODEL_PROVIDER: 'deepseek' }, factory);

  // Act & Assert
  await assert.rejects(
    service.complete([{ role: 'user', content: '你好' }]),
    ChatConfigurationError,
  );
  assert.deepEqual(created, []);
});

test('模型目录只返回公开字段，并标记默认档案', () => {
  // Arrange
  const { factory } = createFakeFactory();
  const service = new LlmService(MULTI_ENV, factory);

  // Act
  const catalog = service.listModels();

  // Assert
  assert.equal(catalog.defaultId, 'deepseek-chat');
  assert.deepEqual(
    catalog.models.map((item) => item.id),
    ['deepseek-chat', 'deepseek-reasoner'],
  );
  for (const item of catalog.models) {
    assert.equal('apiKey' in item, false);
    assert.equal('baseUrl' in item, false);
    assert.equal('timeoutMs' in item, false);
  }
});

test('流式调用把 signal 透传给档案客户端', async () => {
  // Arrange
  const { factory, calls } = createFakeFactory();
  const service = new LlmService(MULTI_ENV, factory);
  const controller = new AbortController();
  const events = [];

  // Act
  for await (const event of service.stream([{ role: 'user', content: '你好' }], {
    profileId: 'deepseek-reasoner',
    signal: controller.signal,
  })) {
    events.push(event);
  }

  // Assert
  assert.equal(calls[0].profileId, 'deepseek-reasoner');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(events, [
    { type: 'delta', content: 'deepseek-reasoner' },
    { type: 'meta', profileId: 'deepseek-reasoner', model: 'deepseek-reasoner', usage: null },
  ]);
});
