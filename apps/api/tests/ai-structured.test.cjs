/**
 * 文件作用：验证分类与实体抽取接口的解析、重试和错误映射。
 *
 * 全部使用 fake transport：不读真实密钥、不访问网络。
 * 重试用例重点确认三件事：确实只重试一次、第二次请求携带失败原因、Token 用量累计。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const OpenAI = require('openai');
const { validate } = require('class-validator');
const { AppError } = require('../dist/common/errors/app-error.js');
const { AiService } = require('../dist/modules/ai/ai.service.js');
const { StructuredTextDto } = require('../dist/modules/ai/dto/structured-text.dto.js');

function transportReturning(outputs, usage = null) {
  const calls = [];
  return {
    calls,
    async complete(messages) {
      calls.push(messages);
      const content = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      return { content, model: 'deepseek-chat', usage };
    },
  };
}

async function validateText(text) {
  const dto = new StructuredTextDto();
  dto.text = text;
  return validate(dto);
}

test('分类接口返回已校验数据，首次成功时 attempts 为 1', async () => {
  // Arrange
  const transport = transportReturning(
    ['{"category":"售后服务","confidence":0.82,"reason":"退款未到账"}'],
    { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
  );
  const service = new AiService(transport);

  // Act
  const result = await service.classify('退款三天未到账');

  // Assert
  assert.deepEqual(result.data, {
    category: '售后服务',
    confidence: 0.82,
    reason: '退款未到账',
  });
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 20, totalTokens: 140 });
  assert.equal(transport.calls.length, 1);
  assert.ok(transport.calls[0][1].content.includes('退款三天未到账'));
});

test('首次输出不合格时重试一次，并累计两次 Token 用量', async () => {
  // Arrange
  const transport = transportReturning(
    [
      '抱歉，我无法分类。',
      '```json\n{"category":"账号与支付","confidence":0.9,"reason":"支付失败"}\n```',
    ],
    { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
  );
  const service = new AiService(transport);

  // Act
  const result = await service.classify('付款一直失败');

  // Assert
  assert.equal(result.attempts, 2);
  assert.equal(result.data.category, '账号与支付');
  assert.deepEqual(result.usage, { promptTokens: 200, completionTokens: 20, totalTokens: 220 });

  assert.equal(transport.calls.length, 2);
  const retryUserMessage = transport.calls[1][1].content;
  assert.ok(retryUserMessage.includes('上一次输出无法解析'));
  assert.ok(retryUserMessage.includes('不要 Markdown 代码块'));
  assert.ok(!retryUserMessage.includes('抱歉，我无法分类'));
});

test('两次都不合格时返回 AI_INVALID_OUTPUT，不无限重试', async () => {
  // Arrange
  const transport = transportReturning(['仍然不是 JSON']);
  const service = new AiService(transport);

  // Act & Assert
  await assert.rejects(service.classify('退款'), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'AI_INVALID_OUTPUT');
    assert.ok(!error.message.includes('仍然不是 JSON'));
    return true;
  });
  assert.equal(transport.calls.length, 2);
});

test('实体抽取返回已校验的实体列表', async () => {
  // Arrange
  const transport = transportReturning([
    '{"entities":[{"type":"组织","value":"某某科技"},{"type":"时间","value":"昨天"}]}',
  ]);
  const service = new AiService(transport);

  // Act
  const result = await service.extractEntities('某某科技昨天发布新品');

  // Assert
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.data.entities, [
    { type: '组织', value: '某某科技' },
    { type: '时间', value: '昨天' },
  ]);
});

test('结构化路径同样安全映射供应商错误', async () => {
  // Arrange
  const service = new AiService({
    async complete() {
      throw new OpenAI.APIConnectionTimeoutError();
    },
  });

  // Act & Assert
  await assert.rejects(service.extractEntities('任意文本'), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'AI_TIMEOUT');
    assert.equal(error.status, 504);
    return true;
  });
});

test('结构化文本 DTO 拒绝空白与超长输入', async () => {
  // Arrange
  const invalidTexts = [' \n ', '', 'a'.repeat(8001), 42];

  // Act & Assert
  for (const text of invalidTexts) {
    const errors = await validateText(text);
    assert.ok(errors.length > 0, String(text).slice(0, 20));
  }

  const valid = await validateText('申请退款三天未到账');
  assert.equal(valid.length, 0);
});
