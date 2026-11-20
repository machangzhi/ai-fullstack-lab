#!/usr/bin/env node
/**
 * Prompt 评测脚本（Week 3 Day 7 调优实践）。
 *
 * 做三件事：
 * 1. 用生产同款的消息组装函数（buildPromptMessages）调用真实模型。
 * 2. 按数据集里的确定性规则打分，不依赖人工或裁判模型。
 * 3. 输出 JSON 原始结果与 Markdown 汇总，便于比较不同 Prompt 版本。
 *
 * 用法：
 *   node evals/run.cjs                        # 跑数据集中的全部版本
 *   node evals/run.cjs --variant support-v2   # 只跑指定版本（可重复）
 *   node evals/run.cjs --dataset evals/datasets/prompt-baseline.json
 *
 * 设计取舍：
 * - temperature 默认 0.2，评测需要可复现，不沿用生产会话的 0.7。
 * - 只支持非流式调用：评测关心最终文本，逐字返回没有价值。
 * - 规则检查刻意保守（包含/排除/长度/JSON 结构），避免主观评分污染结论。
 */

const fs = require('node:fs');
const path = require('node:path');

const EVAL_DIR = __dirname;
const { buildPromptMessages, parseFeedbackClassification } = require('../dist/index.js');

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
  return path.isAbsolute(target) ? target : path.join(EVAL_DIR, target);
}

function loadDataset(options) {
  const file = options.dataset
    ? resolveFromEvalDir(options.dataset)
    : path.join(EVAL_DIR, 'datasets', 'prompt-baseline.json');
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function callModel(config, systemPrompt, userInput) {
  const messages = buildPromptMessages(systemPrompt, userInput);
  const startedAt = Date.now();
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
  return {
    content,
    latencyMs: Date.now() - startedAt,
    usage: data.usage ?? null,
    model: data.model ?? config.model,
  };
}

/** 返回失败原因数组；空数组即通过。 */
function runChecks(checks, content) {
  const failures = [];

  for (const text of checks.contains ?? []) {
    if (!content.includes(text)) failures.push(`缺少「${text}」`);
  }

  const any = checks.containsAny ?? [];
  if (any.length && !any.some((text) => content.includes(text))) {
    failures.push(`未包含任一：${any.join(' / ')}`);
  }

  for (const text of checks.notContains ?? []) {
    if (content.includes(text)) failures.push(`出现禁止内容「${text}」`);
  }

  if (checks.maxChars && content.length > checks.maxChars) {
    failures.push(`长度 ${content.length} 超过 ${checks.maxChars}`);
  }

  if (checks.json) {
    const parsed = parseFeedbackClassification(content);
    if (!parsed.success) {
      failures.push(`JSON 未通过校验：${parsed.reason}`);
    } else {
      const categories = checks.category ?? [];
      if (categories.length && !categories.includes(parsed.data.category)) {
        failures.push(`类别为「${parsed.data.category}」，期望「${categories.join(' / ')}」`);
      }
      if (parsed.data.confidence < 0 || parsed.data.confidence > 1) {
        failures.push('置信度不在 0-1 之间');
      }
      if (parsed.data.reason.length > 40) {
        failures.push(`reason 长度 ${parsed.data.reason.length} 超过 40`);
      }
    }
  }

  return failures;
}

function summarize(variant, results) {
  const passed = results.filter((item) => item.passed).length;
  const totalTokens = results.reduce((sum, item) => sum + (item.usage?.total_tokens ?? 0), 0);
  const avgLatency = Math.round(
    results.reduce((sum, item) => sum + item.latencyMs, 0) / Math.max(results.length, 1),
  );
  const avgChars = Math.round(
    results.reduce((sum, item) => sum + item.content.length, 0) / Math.max(results.length, 1),
  );
  return {
    variant: variant.id,
    template: variant.template,
    note: variant.note ?? '',
    passed,
    total: results.length,
    passRate: results.length ? passed / results.length : 0,
    avgLatency,
    avgChars,
    totalTokens,
  };
}

function buildMarkdownReport(meta, summaries, details) {
  const lines = [
    '# Prompt 评测报告',
    '',
    `- 时间：${meta.finishedAt}`,
    `- 数据集：${path.basename(meta.datasetFile)}`,
    `- 模型：${meta.model}`,
    `- 温度：${meta.temperature}`,
    '',
    '## 汇总',
    '',
    '| 版本 | 模板 | 通过 | 通过率 | 平均耗时 | 平均字数 | 总 Tokens |',
    '| - | - | - | - | - | - | - |',
  ];

  for (const item of summaries) {
    lines.push(
      `| ${item.variant} | ${item.template} | ${item.passed}/${item.total} | ${(item.passRate * 100).toFixed(0)}% | ${item.avgLatency}ms | ${item.avgChars} | ${item.totalTokens} |`,
    );
  }

  for (const item of summaries) {
    lines.push('', `## ${item.variant}`, '');
    if (item.note) lines.push(`说明：${item.note}`, '');
    lines.push('| 用例 | 结果 | 耗时 | Tokens | 失败原因 |', '| - | - | - | - | - |');
    for (const detail of details[item.variant]) {
      const reason = detail.failures.length ? detail.failures.join('；') : '—';
      lines.push(
        `| ${detail.caseId} | ${detail.passed ? 'PASS' : 'FAIL'} | ${detail.latencyMs}ms | ${detail.usage?.total_tokens ?? 0} | ${reason} |`,
      );
    }
  }

  lines.push('', '## 同模板版本对比', '');
  const byTemplate = new Map();
  for (const item of summaries) {
    if (!byTemplate.has(item.template)) byTemplate.set(item.template, []);
    byTemplate.get(item.template).push(item);
  }
  for (const [template, items] of byTemplate) {
    lines.push(`### ${template}`, '');
    if (items.length < 2) {
      lines.push('- 只有一个版本，无法对比。');
    } else {
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1];
        const current = items[index];
        const delta = current.passRate - previous.passRate;
        lines.push(
          `- ${previous.variant} → ${current.variant}：通过率 ${(previous.passRate * 100).toFixed(0)}% → ${(current.passRate * 100).toFixed(0)}%（${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)} 个百分点）`,
        );
      }
      for (const detail of details[items.at(-1).variant]) {
        if (!detail.passed) {
          lines.push(`- 仍失败：${detail.caseId} —— ${detail.failures.join('；')}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
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

  const details = {};
  const summaries = [];
  let modelSeen = config.model;

  for (const variant of variants) {
    const cases = dataset.cases.filter((item) => item.template === variant.template);
    const systemPrompt = fs.readFileSync(resolveFromEvalDir(variant.file), 'utf8').trim();
    details[variant.id] = [];

    for (const testCase of cases) {
      process.stdout.write(`[${variant.id}] ${testCase.id} ... `);
      try {
        const result = await callModel(config, systemPrompt, testCase.input);
        const failures = runChecks(testCase.checks ?? {}, result.content);
        modelSeen = result.model;
        details[variant.id].push({
          caseId: testCase.id,
          passed: failures.length === 0,
          failures,
          latencyMs: result.latencyMs,
          usage: result.usage,
          content: result.content,
          chars: result.content.length,
        });
        console.log(failures.length === 0 ? 'PASS' : `FAIL (${failures.join('；')})`);
      } catch (error) {
        details[variant.id].push({
          caseId: testCase.id,
          passed: false,
          failures: [`调用失败：${error.message}`],
          latencyMs: 0,
          usage: null,
          content: '',
          chars: 0,
        });
        console.log(`ERROR (${error.message})`);
      }
    }

    const summary = summarize(variant, details[variant.id]);
    summaries.push(summary);
  }

  const finishedAt = new Date().toISOString();
  const reportDir = options.reportDir
    ? resolveFromEvalDir(options.reportDir)
    : path.join(EVAL_DIR, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const stamp = finishedAt.replace(/[:.]/g, '-');
  const jsonFile = path.join(reportDir, `${stamp}.json`);
  const markdownFile = path.join(reportDir, `${stamp}.md`);
  const meta = { finishedAt, datasetFile, model: modelSeen, temperature: config.temperature };

  fs.writeFileSync(jsonFile, JSON.stringify({ meta, summaries, details }, null, 2), 'utf8');
  fs.writeFileSync(markdownFile, buildMarkdownReport(meta, summaries, details), 'utf8');

  console.log('\n汇总：');
  for (const item of summaries) {
    console.log(
      `- ${item.variant}: ${item.passed}/${item.total} 通过，平均 ${item.avgLatency}ms，${item.totalTokens} Tokens`,
    );
  }
  console.log(`\n报告：${markdownFile}`);
})();
