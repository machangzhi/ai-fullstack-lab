/**
 * 文件作用：多模型档案解析测试（Week 4 Day 1）。
 *
 * 全部注入假的 env 对象：既不读取本机 .env，也不访问网络。
 * 重点覆盖：基础配置继承、按档案覆盖、公开字段白名单与配置错误。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveModelProfiles,
  selectModelProfile,
  toPublicModelProfile,
} = require('../dist/index.js');

const BASE_ENV = {
  MODEL_PROVIDER: 'deepseek',
  MODEL_API_KEY: 'test-base-key',
  MODEL_TEMPERATURE: '0.7',
  MODEL_MAX_TOKENS: '2048',
  MODEL_TIMEOUT_MS: '30000',
};

const MULTI_ENV = {
  ...BASE_ENV,
  MODEL_PROFILES: 'deepseek-chat,deepseek-reasoner',
  MODEL_DEFAULT_PROFILE: 'deepseek-reasoner',
  MODEL_PROFILE_DEEPSEEK_CHAT_LABEL: 'DeepSeek Chat',
  MODEL_PROFILE_DEEPSEEK_CHAT_MODEL: 'deepseek-chat',
  MODEL_PROFILE_DEEPSEEK_CHAT_CONTEXT_WINDOW: '65536',
  MODEL_PROFILE_DEEPSEEK_REASONER_LABEL: 'DeepSeek Reasoner',
  MODEL_PROFILE_DEEPSEEK_REASONER_MODEL: 'deepseek-reasoner',
  MODEL_PROFILE_DEEPSEEK_REASONER_TEMPERATURE: '0.2',
  MODEL_PROFILE_DEEPSEEK_REASONER_CONTEXT_WINDOW: '65536',
  MODEL_PROFILE_DEEPSEEK_REASONER_API_KEY_ENV: 'REASONER_API_KEY',
  REASONER_API_KEY: 'test-reasoner-key',
};

test('未配置 MODEL_PROFILES 时生成一个 default 档案，保持 Week 3 用法', () => {
  // Act
  const registry = resolveModelProfiles(BASE_ENV);

  // Assert
  assert.equal(registry.defaultProfileId, 'default');
  assert.equal(registry.profiles.length, 1);
  assert.deepEqual(registry.profiles[0], {
    id: 'default',
    label: 'deepseek-chat',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'test-base-key',
    temperature: 0.7,
    maxTokens: 2048,
    timeoutMs: 30000,
    capabilities: { streaming: true, contextWindow: 32768 },
  });
});

test('多个档案继承基础配置并按需覆盖模型、温度与上下文窗口', () => {
  // Act
  const registry = resolveModelProfiles(MULTI_ENV);
  const chat = selectModelProfile(registry, 'deepseek-chat');
  const reasoner = selectModelProfile(registry, 'deepseek-reasoner');

  // Assert
  assert.equal(registry.defaultProfileId, 'deepseek-reasoner');
  assert.deepEqual(
    registry.profiles.map((item) => item.id),
    ['deepseek-chat', 'deepseek-reasoner'],
  );

  assert.equal(chat.label, 'DeepSeek Chat');
  assert.equal(chat.model, 'deepseek-chat');
  assert.equal(chat.temperature, 0.7);
  assert.equal(chat.capabilities.contextWindow, 65536);
  assert.equal(chat.apiKey, 'test-base-key');

  assert.equal(reasoner.label, 'DeepSeek Reasoner');
  assert.equal(reasoner.model, 'deepseek-reasoner');
  assert.equal(reasoner.temperature, 0.2);
  assert.equal(reasoner.capabilities.contextWindow, 65536);
  assert.equal(reasoner.apiKey, 'test-reasoner-key');
  // 未覆盖的连接参数继续继承基础配置。
  assert.equal(reasoner.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(reasoner.timeoutMs, 30000);
});

test('不传档案 ID 时返回默认档案，未知档案显式失败', () => {
  // Arrange
  const registry = resolveModelProfiles(MULTI_ENV);

  // Act & Assert
  assert.equal(selectModelProfile(registry).id, 'deepseek-reasoner');
  assert.throws(() => selectModelProfile(registry, 'gpt-4o'), /Unknown model profile/);
});

test('公开档案采用白名单，不包含密钥、地址与超时', () => {
  // Arrange
  const registry = resolveModelProfiles(MULTI_ENV);
  const publicProfile = toPublicModelProfile(selectModelProfile(registry, 'deepseek-chat'));

  // Act & Assert
  assert.deepEqual(publicProfile, {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 2048,
    capabilities: { streaming: true, contextWindow: 65536 },
  });
  assert.equal('apiKey' in publicProfile, false);
  assert.equal('baseUrl' in publicProfile, false);
  assert.equal('timeoutMs' in publicProfile, false);
});

test('拒绝重复、非法与超过上限的档案 ID', () => {
  // Act & Assert
  assert.throws(
    () => resolveModelProfiles({ ...BASE_ENV, MODEL_PROFILES: 'chat,chat' }),
    /Duplicate model profile id/,
  );
  assert.throws(
    () => resolveModelProfiles({ ...BASE_ENV, MODEL_PROFILES: 'Chat_1' }),
    /Invalid model profile id/,
  );
  assert.throws(
    () => resolveModelProfiles({ ...BASE_ENV, MODEL_PROFILES: '  ,  ' }),
    /at least one profile id/,
  );
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'a,b,c,d,e,f,g,h,i',
      }),
    /at most 8 profiles/,
  );
});

test('拒绝不存在的默认档案和非法布尔值', () => {
  // Act & Assert
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'chat',
        MODEL_DEFAULT_PROFILE: 'reasoner',
      }),
    /MODEL_DEFAULT_PROFILE/,
  );
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'chat',
        MODEL_PROFILE_CHAT_STREAMING: 'yes',
      }),
    /STREAMING must be true or false/,
  );
});

test('API_KEY_ENV 只保存变量名，变量缺失时错误信息不含密钥值', () => {
  // Act & Assert
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'chat',
        MODEL_PROFILE_CHAT_API_KEY_ENV: 'MISSING_MODEL_KEY',
      }),
    (error) => {
      assert.match(error.message, /MISSING_MODEL_KEY/);
      assert.equal(error.message.includes('test-base-key'), false);
      return true;
    },
  );
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'chat',
        MODEL_PROFILE_CHAT_API_KEY_ENV: 'not-a-name',
      }),
    /must be an environment variable name/,
  );
});

test('切换供应商时必须显式覆盖地址与模型', () => {
  // Act & Assert
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'openai',
        MODEL_PROFILE_OPENAI_PROVIDER: 'openai-compatible',
      }),
    /BASE_URL is required when changing provider/,
  );
  assert.throws(
    () =>
      resolveModelProfiles({
        ...BASE_ENV,
        MODEL_PROFILES: 'openai',
        MODEL_PROFILE_OPENAI_PROVIDER: 'openai-compatible',
        MODEL_PROFILE_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      }),
    /MODEL is required when changing provider/,
  );
});
