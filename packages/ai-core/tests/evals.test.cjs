/**
 * 文件作用：验证评测规则、指标计算与执行器（Week 4 Day 5）。
 *
 * 这些测试完全不访问网络：模型调用通过 runVariant 的 callModel 参数注入 Mock，
 * 时钟也由测试控制，因此延迟断言是稳定的。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  compareSummaries,
  runChecks,
  runVariant,
  summarizeLatency,
  summarizeResults,
} = require('../dist/index.js');

const DATASET_FILE = path.join(__dirname, '..', 'evals', 'datasets', 'prompt-suite-20.json');

describe('确定性规则校验', () => {
  test('全部规则满足时返回空数组', () => {
    // Arrange
    const checks = {
      contains: ['退款'],
      containsAny: ['人工', '核实'],
      notContains: ['保证退款'],
      maxChars: 80,
      json: true,
      category: ['售后服务'],
    };
    const content = '{"category":"售后服务","confidence":0.9,"reason":"退款需人工核实"}';

    // Act
    const failures = runChecks(checks, content);

    // Assert
    assert.deepEqual(failures, []);
  });

  test('逐项返回失败原因，而不是只给一个布尔值', () => {
    // Arrange
    const checks = {
      contains: ['转人工'],
      containsAny: ['抱歉', '无法'],
      notContains: ['保证退款'],
      maxChars: 5,
    };
    const content = '我们保证退款。';

    // Act
    const failures = runChecks(checks, content);

    // Assert
    assert.equal(failures.length, 4);
    assert.ok(failures.some((item) => item.includes('缺少「转人工」')));
    assert.ok(failures.some((item) => item.includes('未包含任一')));
    assert.ok(failures.some((item) => item.includes('出现禁止内容')));
    assert.ok(failures.some((item) => item.includes('超过 5')));
  });

  test('分类 JSON 非法或类别不符时失败', () => {
    // Arrange
    const checks = { json: true, category: ['物流配送'] };

    // Act
    const invalidJson = runChecks(checks, '这是物流问题。');
    const wrongCategory = runChecks(
      checks,
      '{"category":"售后服务","confidence":0.8,"reason":"退款问题"}',
    );

    // Assert
    assert.ok(invalidJson[0].includes('JSON 未通过校验'));
    assert.ok(wrongCategory[0].includes('类别为「售后服务」'));
  });
});

describe('延迟统计', () => {
  test('计算平均值与 P50/P95（线性插值）', () => {
    // Act
    const stats = summarizeLatency([400, 100, 300, 200]);

    // Assert
    assert.equal(stats.count, 4);
    assert.equal(stats.avgMs, 250);
    assert.equal(stats.p50Ms, 250);
    assert.equal(stats.p95Ms, 385);
    assert.equal(stats.minMs, 100);
    assert.equal(stats.maxMs, 400);
  });

  test('空样本返回全零，不抛异常', () => {
    // Act
    const stats = summarizeLatency([]);

    // Assert
    assert.deepEqual(stats, { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0 });
  });
});

describe('汇总指标', () => {
  test('区分准确率、成功率与失败率，并把失败调用排除在延迟之外', () => {
    // Arrange：2 条通过、1 条调用成功但校验失败、1 条调用失败。
    const results = [
      { caseId: 'a', template: 'support', input: '', expected: '', output: 'ok', passed: true, succeeded: true, failures: [], latencyMs: 100, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 10 } },
      { caseId: 'b', template: 'support', input: '', expected: '', output: 'bad', passed: false, succeeded: true, failures: ['缺少关键词'], latencyMs: 200, usage: { promptTokens: 2, completionTokens: 2, totalTokens: 20 } },
      { caseId: 'c', template: 'support', input: '', expected: '', output: '', passed: false, succeeded: false, failures: ['调用失败：超时'], latencyMs: 5000, usage: null },
      { caseId: 'd', template: 'support', input: '', expected: '', output: 'ok', passed: true, succeeded: true, failures: [], latencyMs: 300, usage: { promptTokens: 3, completionTokens: 3, totalTokens: 30 } },
    ];

    // Act
    const summary = summarizeResults({ id: 'support-v1', template: 'support' }, results);

    // Assert
    assert.equal(summary.total, 4);
    assert.equal(summary.passed, 2);
    assert.equal(summary.checkFailed, 1);
    assert.equal(summary.errored, 1);
    assert.equal(summary.accuracy, 0.5);
    assert.equal(summary.successRate, 0.75);
    assert.equal(summary.failureRate, 0.25);
    assert.equal(summary.latency.count, 3);
    assert.equal(summary.latency.avgMs, 200);
    assert.equal(summary.latency.p95Ms, 290);
    assert.equal(summary.totalTokens, 60);
  });

  test('对比两个版本时输出准确率与延迟差值', () => {
    // Arrange
    const latency = (avgMs, p50Ms, p95Ms) => ({ count: 2, avgMs, p50Ms, p95Ms, minMs: 0, maxMs: 0 });
    const baseline = { variantId: 'v1', template: 'classify', note: '', total: 4, passed: 3, checkFailed: 1, errored: 0, accuracy: 0.75, successRate: 1, failureRate: 0, latency: latency(1000, 900, 1500), totalTokens: 0 };
    const candidate = { variantId: 'v2', template: 'classify', note: '', total: 4, passed: 4, checkFailed: 0, errored: 0, accuracy: 1, successRate: 1, failureRate: 0, latency: latency(800, 700, 1200), totalTokens: 0 };

    // Act
    const comparison = compareSummaries(baseline, candidate);

    // Assert
    assert.equal(comparison.accuracyDelta, 0.25);
    assert.equal(comparison.avgLatencyDeltaMs, -200);
    assert.equal(comparison.p50LatencyDeltaMs, -200);
    assert.equal(comparison.p95LatencyDeltaMs, -300);
  });
});

describe('评测执行器（Mock 模型）', () => {
  test('逐条记录输出、耗时与错误，单条失败不中断整轮', async () => {
    // Arrange
    const cases = [
      { id: 'ok', template: 'support', input: '退款', expected: '提到转人工', checks: { contains: ['转人工'] } },
      { id: 'bad', template: 'support', input: '发票', expected: '提到发票', checks: { contains: ['发票'] } },
      { id: 'boom', template: 'support', input: '登录', expected: '正常返回', checks: {} },
    ];
    const replies = {
      ok: '需要转人工：退款异常。',
      bad: '请提供订单号。',
    };
    const seen = [];
    let tick = 0;
    const onResult = [];
    const callModel = async (context) => {
      seen.push(context.caseId);
      if (context.caseId === 'boom') throw new Error('模拟超时');
      return { content: replies[context.caseId], model: 'mock-model' };
    };

    // Act
    const run = await runVariant({
      variant: { id: 'support-mock', template: 'support' },
      cases,
      systemPrompt: '测试提示词',
      callModel,
      now: () => {
        tick += 50;
        return tick;
      },
      onResult: (result) => onResult.push(result.caseId),
    });

    // Assert
    assert.deepEqual(seen, ['ok', 'bad', 'boom']);
    assert.deepEqual(onResult, ['ok', 'bad', 'boom']);
    assert.deepEqual(run.models, ['mock-model']);
    assert.deepEqual(run.results.map((item) => item.passed), [true, false, false]);
    assert.deepEqual(run.results.map((item) => item.succeeded), [true, true, false]);
    assert.equal(run.results[0].output, '需要转人工：退款异常。');
    assert.equal(run.results[1].output, '请提供订单号。');
    assert.equal(run.results[2].output, '');
    assert.equal(run.results[2].failures[0], '调用失败：模拟超时');
    assert.equal(run.results[0].latencyMs, 50);
    assert.equal(run.summary.accuracy, 1 / 3);
    assert.equal(run.summary.successRate, 2 / 3);
    assert.equal(run.summary.failureRate, 1 / 3);
    assert.equal(run.summary.latency.count, 2);
  });
});

describe('20 条固定测试集', () => {
  test('数据集覆盖客服与分类各 10 条，且字段完整、ID 唯一', () => {
    // Arrange
    const dataset = JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8'));

    // Act
    const supportCases = dataset.cases.filter((item) => item.template === 'support');
    const classifyCases = dataset.cases.filter((item) => item.template === 'classify');
    const ids = dataset.cases.map((item) => item.id);

    // Assert
    assert.equal(dataset.cases.length, 20);
    assert.equal(supportCases.length, 10);
    assert.equal(classifyCases.length, 10);
    assert.equal(new Set(ids).size, 20);

    for (const item of dataset.cases) {
      assert.ok(item.input.length > 0, `${item.id} 缺少输入`);
      assert.ok(item.expected.length > 0, `${item.id} 缺少期望说明`);
      assert.ok(Object.keys(item.checks).length > 0, `${item.id} 缺少检查规则`);
    }

    const variantIds = dataset.variants.map((item) => item.id);
    assert.deepEqual(variantIds, ['support-v1', 'support-v2', 'classify-v1', 'classify-v2']);
    for (const variant of dataset.variants) {
      const file = path.join(__dirname, '..', 'evals', variant.file);
      assert.ok(fs.existsSync(file), `${variant.id} 的 Prompt 文件不存在`);
    }
  });
});
