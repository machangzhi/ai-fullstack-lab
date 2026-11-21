#!/usr/bin/env node
/**
 * Prompt 评测脚本（Week 3 Day 7 建立，Week 4 Day 5 扩展为 20 条固定测试集）。
 *
 * 做四件事：
 * 1. 用生产同款的消息组装函数（buildPromptMessages）调用真实模型。
 * 2. 逐条记录模型输出、期望、是否通过、耗时与错误，写进 JSON 报告。
 * 3. 汇总准确率、成功率、失败率与平均/P50/P95 延迟（计算逻辑在 ai-core 的 evals 模块）。
 * 4. 按模板比较 v1/v2 两套 Prompt，输出 Markdown 报告。
 *
 * 用法：
 *   node evals/run.cjs --dataset evals/datasets/prompt-suite-20.json
 *   node evals/run.cjs --dataset evals/datasets/prompt-suite-20.json --variant support-v2
 *   pnpm --filter @ai-lab/ai-core eval:suite
 *
 * 设计取舍：
 * - temperature 默认 0.2，评测需要可复现，不沿用生产会话的 0.7。
 * - 只支持非流式调用：评测关心最终文本，逐字返回没有价值。
 * - 串行执行：并发请求会互相争抢连接与限流额度，延迟不再具备可比性。
 * - 规则检查刻意保守（包含/排除/长度/JSON 结构），避免主观评分污染结论。
 */

const fs = require('node:fs');
const path = require('node:path');

const EVAL_DIR = __dirname;
const { buildPromptMessages, runVariant, compareSummaries } = require('../dist/index.js');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(EVAL_DIR, '..', '..', '..', 'apps', 'api', '.env'));

function parseArgs(argv) {
  const options = { variants: [], dataset: null, reportDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--variant') {
      options.variants.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--dataset') {
      options.dataset = argv[index + 1];
      index += 1;
    } else if (arg === '--report-dir') {
      options.reportDir = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function resolveFromEvalDir(target) {
  if (path.isAbsolute(target)) return target;
  // 显式传入的路径既可能相对包根目录（pnpm script 的 cwd），也可能相对 evals 目录；
  // 优先使用真实存在的那个，避免出现 evals/evals/... 这类重复拼接。
  const fromCwd = path.resolve(process.cwd(), target);
  return fs.existsSync(fromCwd) ? fromCwd : path.join(EVAL_DIR, target);
}

function loadDataset(options) {
  const file = options.dataset
    ? resolveFromEvalDir(options.dataset)
    : path.join(EVAL_DIR, 'datasets', 'prompt-baseline.json');
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** 真实模型调用：只返回内容与用量，耗时由 runVariant 统一测量。 */
async function callModel(config, systemPrompt, userInput) {
  const messages = buildPromptMessages(systemPrompt, userInput);
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`模型返回 HTTP ${response.status}：${body}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() ?? '';
  const usage = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      }
    : null;

  return { content, usage, model: data.model ?? config.model };
}

function percent(ratio) {
  return `${(ratio * 100).toFixed(0)}%`;
}

function signedPoints(delta) {
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)} 个百分点`;
}

function signedMs(delta) {
  return `${delta >= 0 ? '+' : ''}${delta}ms`;
}

/** 表格单元格：折叠换行、转义竖线，并截断过长的模型输出。 */
function toCell(value, maxLength = 60) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  if (!text) return '—';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function resultLabel(result) {
  if (!result.succeeded) return 'ERROR';
  return result.passed ? 'PASS' : 'FAIL';
}

function buildMarkdownReport(meta, runs, comparisons) {
  const lines = [
    '# Prompt 评测报告',
    '',
    `- 时间：${meta.finishedAt}`,
    `- 数据集：${path.basename(meta.datasetFile)}（${meta.datasetName}）`,
    `- 数据集用例数：${meta.datasetCaseCount}`,
    `- 本次执行：${meta.executedCount}（${meta.variantCount} 个版本）`,
    `- 模型：${meta.model}`,
    `- 温度：${meta.temperature}`,
    '',
    '## 指标口径',
    '',
    '- 准确率 = 通过规则校验的用例数 / 总用例数。',
    '- 成功率 = 模型调用成功的用例数 / 总用例数。',
    '- 失败率 = 模型调用失败（超时、HTTP 错误、断网）的用例数 / 总用例数。',
    '- 延迟只统计调用成功的用例，单位为毫秒；P50/P95 使用线性插值。',
    '',
    '## 汇总',
    '',
    '| 版本 | 模板 | 通过 | 准确率 | 成功率 | 失败率 | 平均延迟 | P50 | P95 | Tokens |',
    '| - | - | - | - | - | - | - | - | - | - |',
  ];

  for (const run of runs) {
    const item = run.summary;
    lines.push(
      `| ${item.variantId} | ${item.template} | ${item.passed}/${item.total} | ${percent(item.accuracy)} | ${percent(item.successRate)} | ${percent(item.failureRate)} | ${item.latency.avgMs}ms | ${item.latency.p50Ms}ms | ${item.latency.p95Ms}ms | ${item.totalTokens} |`,
    );
  }

  for (const run of runs) {
    const item = run.summary;
    lines.push('', `## ${item.variantId}`, '');
    if (item.note) lines.push(`说明：${item.note}`, '');
    lines.push(
      '| 用例 | 结果 | 耗时 | 期望 | 输出摘要 | 失败原因 |',
      '| - | - | - | - | - | - |',
    );
    for (const detail of run.results) {
      lines.push(
        `| ${detail.caseId} | ${resultLabel(detail)} | ${detail.latencyMs}ms | ${toCell(detail.expected, 40)} | ${toCell(detail.output)} | ${detail.failures.length ? detail.failures.join('；') : '—'} |`,
      );
    }
  }

  lines.push('', '## Prompt 版本对比', '');
  if (comparisons.length === 0) {
    lines.push('- 每个模板只有一个版本，无法对比。');
  }

  for (const comparison of comparisons) {
    const { baseline, candidate, delta } = comparison;
    lines.push(`### ${comparison.template}：${baseline.variantId} → ${candidate.variantId}`, '');
    lines.push(
      `- 准确率：${percent(baseline.accuracy)} → ${percent(candidate.accuracy)}（${signedPoints(delta.accuracyDelta)}）`,
      `- 成功率：${percent(baseline.successRate)} → ${percent(candidate.successRate)}（${signedPoints(delta.successRateDelta)}）`,
      `- 平均延迟：${baseline.latency.avgMs}ms → ${candidate.latency.avgMs}ms（${signedMs(delta.avgLatencyDeltaMs)}）`,
      `- P95 延迟：${baseline.latency.p95Ms}ms → ${candidate.latency.p95Ms}ms（${signedMs(delta.p95LatencyDeltaMs)}）`,
    );

    const baselineById = new Map(baseline.results.map((item) => [item.caseId, item]));
    const improved = [];
    const regressed = [];
    for (const detail of candidate.results) {
      const previous = baselineById.get(detail.caseId);
      if (!previous) continue;
      if (!previous.passed && detail.passed) improved.push(detail.caseId);
      if (previous.passed && !detail.passed) regressed.push(detail.caseId);
    }

    if (improved.length) lines.push(`- 由失败转为通过：${improved.join('、')}`);
    if (regressed.length) lines.push(`- 由通过转为失败：${regressed.join('、')}`);
    lines.push('');
  }

  return lines.join('\n');
}

function buildComparisons(runs) {
  const byTemplate = new Map();
  for (const run of runs) {
    if (!byTemplate.has(run.summary.template)) byTemplate.set(run.summary.template, []);
    byTemplate.get(run.summary.template).push(run);
  }

  const comparisons = [];
  for (const [template, items] of byTemplate) {
    for (let index = 1; index < items.length; index += 1) {
      const baseline = items[index - 1];
      const candidate = items[index];
      comparisons.push({
        template,
        baseline: { ...baseline.summary, results: baseline.results },
        candidate: { ...candidate.summary, results: candidate.results },
        delta: compareSummaries(baseline.summary, candidate.summary),
      });
    }
  }
  return comparisons;
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  const { file: datasetFile, data: dataset } = loadDataset(options);

  const config = {
    apiKey: process.env.MODEL_API_KEY ?? '',
    baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.MODEL_NAME ?? 'deepseek-chat',
    temperature: Number(process.env.EVAL_TEMPERATURE ?? 0.2),
    maxTokens: Number(process.env.EVAL_MAX_TOKENS ?? 500),
    timeoutMs: 45_000,
  };

  if (!config.apiKey) {
    console.error('缺少 MODEL_API_KEY：请在 apps/api/.env 中配置，或通过环境变量提供。');
    process.exitCode = 1;
    return;
  }

  const variants = dataset.variants.filter(
    (variant) => options.variants.length === 0 || options.variants.includes(variant.id),
  );
  if (variants.length === 0) {
    console.error('没有匹配的版本，请检查 --variant 参数。');
    process.exitCode = 1;
    return;
  }

  const runs = [];
  let modelSeen = config.model;

  for (const variant of variants) {
    const cases = dataset.cases.filter((item) => item.template === variant.template);
    if (cases.length === 0) {
      console.warn(`[${variant.id}] 数据集里没有对应用例，已跳过。`);
      continue;
    }

    const systemPrompt = fs.readFileSync(resolveFromEvalDir(variant.file), 'utf8').trim();
    console.log(`[${variant.id}] 开始执行 ${cases.length} 条用例`);

    const run = await runVariant({
      variant,
      cases,
      systemPrompt,
      callModel: ({ systemPrompt: prompt, userInput }) => callModel(config, prompt, userInput),
      onResult: (result) => {
        const reason = result.failures.length ? ` (${result.failures.join('；')})` : '';
        console.log(
          `[${variant.id}] ${result.caseId} ... ${resultLabel(result)} ${result.latencyMs}ms${reason}`,
        );
      },
    });

    if (run.models.length > 0) {
      modelSeen = run.models[run.models.length - 1];
    }
    runs.push(run);
  }

  const finishedAt = new Date().toISOString();
  const reportDir = options.reportDir
    ? resolveFromEvalDir(options.reportDir)
    : path.join(EVAL_DIR, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const stamp = finishedAt.replace(/[:.]/g, '-');
  const jsonFile = path.join(reportDir, `${stamp}.json`);
  const markdownFile = path.join(reportDir, `${stamp}.md`);
  const meta = {
    finishedAt,
    datasetFile,
    datasetName: dataset.name ?? path.basename(datasetFile, '.json'),
    datasetCaseCount: dataset.cases.length,
    variantCount: runs.length,
    executedCount: runs.reduce((sum, run) => sum + run.results.length, 0),
    model: modelSeen,
    temperature: config.temperature,
  };

  const comparisons = buildComparisons(runs);
  const details = {};
  for (const run of runs) {
    details[run.summary.variantId] = run.results;
  }

  fs.writeFileSync(
    jsonFile,
    JSON.stringify({ meta, summaries: runs.map((run) => run.summary), details }, null, 2),
    'utf8',
  );
  fs.writeFileSync(markdownFile, buildMarkdownReport(meta, runs, comparisons), 'utf8');

  console.log('\n汇总：');
  for (const run of runs) {
    const item = run.summary;
    console.log(
      `- ${item.variantId}: 准确率 ${percent(item.accuracy)}，成功率 ${percent(item.successRate)}，` +
        `平均 ${item.latency.avgMs}ms，P95 ${item.latency.p95Ms}ms，${item.totalTokens} Tokens`,
    );
  }
  console.log(`\n报告：${markdownFile}`);
})();
