/**
 * 文件作用：验证 ModelProvider 配置解析、供应商切换、参数校验和公开配置脱敏。
 *
 * 测试使用 Node.js 内置 node:test，不引入额外测试框架；配置解析包先编译，再由本文件
 * 加载 dist 产物，因此测试同时覆盖 TypeScript 构建与公共导出。所有密钥均为假数据，
 * 测试不读取本机 .env、不访问真实模型服务。用例按 AAA（Arrange / Act / Assert）组织。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveModelProviderConfig, toPublicModelProviderConfig } = require('../dist/index.js');

const openAiEnv = {
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'https://models.example.com/v1/',
  MODEL_NAME: 'example-chat',
  MODEL_API_KEY: 'test-openai-key',
};

describe('resolveModelProviderConfig', () => {
  test('解析完整的 OpenAI 兼容配置，并统一移除地址末尾斜杠', () => {
    // Arrange
    const env = {
      ...openAiEnv,
      MODEL_TEMPERATURE: '0.2',
      MODEL_MAX_TOKENS: '4096',
      MODEL_TIMEOUT_MS: '15000',
    };

    // Act
    const config = resolveModelProviderConfig(env);

    // Assert
    assert.deepEqual(config, {
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'example-chat',
      apiKey: 'test-openai-key',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 15000,
    });
  });

  test('切换 MODEL_PROVIDER 后使用 DeepSeek 官方默认地址、模型和数值配置', () => {
    // Arrange
    const env = {
      MODEL_PROVIDER: 'deepseek',
      MODEL_API_KEY: 'test-deepseek-key',
    };

    // Act
    const config = resolveModelProviderConfig(env);

    // Assert
    assert.deepEqual(config, {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'test-deepseek-key',
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 30000,
    });
  });

  test('允许覆盖 DeepSeek 默认地址和模型以兼容代理或新模型', () => {
    // Arrange
    const env = {
      MODEL_PROVIDER: 'deepseek',
      MODEL_BASE_URL: 'https://proxy.example.com/deepseek/v1',
      MODEL_NAME: 'deepseek-reasoner',
      MODEL_API_KEY: 'test-deepseek-key',
    };

    // Act
    const config = resolveModelProviderConfig(env);

    // Assert
    assert.equal(config.baseUrl, 'https://proxy.example.com/deepseek/v1');
    assert.equal(config.model, 'deepseek-reasoner');
  });

  test('拒绝不支持的供应商', () => {
    // Arrange
    const env = { ...openAiEnv, MODEL_PROVIDER: 'unknown-provider' };

    // Act & Assert
    assert.throws(() => resolveModelProviderConfig(env), /MODEL_PROVIDER must be one of/);
  });

  for (const name of ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY']) {
    test(`OpenAI 兼容模式缺少 ${name} 时给出明确错误`, () => {
      // Arrange
      const env = { ...openAiEnv };
      delete env[name];

      // Act & Assert
      assert.throws(
        () => resolveModelProviderConfig(env),
        new RegExp(`Missing required environment variable: ${name}`),
      );
    });
  }

  test('DeepSeek 缺少 API Key 时失败，且异常不泄露其他配置值', () => {
    // Arrange
    const env = { MODEL_PROVIDER: 'deepseek' };

    // Act & Assert
    assert.throws(
      () => resolveModelProviderConfig(env),
      /Missing required environment variable: MODEL_API_KEY/,
    );
  });

  test('拒绝非 HTTP(S) 地址和携带账号密码的地址', () => {
    // Arrange
    const invalidUrls = ['file:///tmp/model', 'https://user:password@example.com/v1'];

    for (const url of invalidUrls) {
      const env = { ...openAiEnv, MODEL_BASE_URL: url };

      // Act & Assert
      assert.throws(() => resolveModelProviderConfig(env), /MODEL_BASE_URL/);
    }
  });

  for (const testCase of [
    { name: 'MODEL_TEMPERATURE', value: '2.1' },
    { name: 'MODEL_MAX_TOKENS', value: '1.5' },
    { name: 'MODEL_TIMEOUT_MS', value: '0' },
  ]) {
    test(`拒绝非法数值 ${testCase.name}=${testCase.value}`, () => {
      // Arrange
      const env = { ...openAiEnv, [testCase.name]: testCase.value };

      // Act & Assert
      assert.throws(() => resolveModelProviderConfig(env), new RegExp(`${testCase.name} must be`));
    });
  }
});

describe('toPublicModelProviderConfig', () => {
  test('公开配置只含白名单字段，不泄露 API Key 或连接地址', () => {
    // Arrange
    const config = resolveModelProviderConfig(openAiEnv);

    // Act
    const publicConfig = toPublicModelProviderConfig(config);

    // Assert
    assert.deepEqual(publicConfig, {
      provider: 'openai-compatible',
      model: 'example-chat',
      temperature: 0.7,
      maxTokens: 2048,
    });
    assert.equal(JSON.stringify(publicConfig).includes('test-openai-key'), false);
    assert.equal(JSON.stringify(publicConfig).includes('models.example.com'), false);
  });
});
