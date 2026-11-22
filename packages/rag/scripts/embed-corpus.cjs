#!/usr/bin/env node
/**
 * 文件作用：批量向量化 100 条固定文本，并保存向量与元数据（Week 5 Day 4）。
 *
 * 用法：
 *   pnpm --filter @ai-lab/rag embed:corpus
 *   pnpm --filter @ai-lab/rag embed:corpus -- --limit 20 --batch-size 8
 *
 * 需要环境变量（可写在 apps/api/.env）：
 *   EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL
 *   EMBEDDING_DIMENSIONS（可选）/ EMBEDDING_BATCH_SIZE / EMBEDDING_TIMEOUT_MS
 *
 * 产物：packages/rag/reports/embeddings-<时间>.json
 * 报告包含模型、维度、批量参数、每批耗时、Token 用量与每条文本的完整向量。
 * 报告与密钥无关，但仍属于本地调试产物，默认不入库。
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');
const DEFAULT_INPUT = path.join(PACKAGE_ROOT, 'evals', 'datasets', 'embedding-corpus.json');
const DEFAULT_REPORT_DIR = path.join(PACKAGE_ROOT, 'reports');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(PACKAGE_ROOT, '..', '..', 'apps', 'api', '.env'));

const {
  resolveEmbeddingConfig,
  createEmbeddingClient,
  embedTexts,
  EmbeddingError,
} = require('../dist/index.js');

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    reportDir: DEFAULT_REPORT_DIR,
    limit: 100,
    batchSize: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      options.input = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (arg === '--report-dir') {
      options.reportDir = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (arg === '--limit') {
      options.limit = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--batch-size') {
      options.batchSize = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit 必须是正整数');
  }
  if (
    options.batchSize !== null &&
    (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 128)
  ) {
    throw new Error('--batch-size 必须是 1~128 的整数');
  }

  return options;
}

function loadTexts(file, limit) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(payload.texts) || payload.texts.length === 0) {
    throw new Error(`数据集缺少 texts 数组：${file}`);
  }

  const texts = payload.texts.slice(0, limit);
  if (texts.some((text) => typeof text !== 'string' || !text.trim())) {
    throw new Error('数据集中存在空文本');
  }
  return texts;
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveEmbeddingConfig(process.env);
  const texts = loadTexts(options.input, options.limit);
  const batchSize = options.batchSize ?? config.batchSize;

  console.log(`模型：${config.model}`);
  console.log(`文本：${texts.length} 条，批量：${batchSize}，维度：${config.dimensions ?? '模型默认'}`);

  const client = createEmbeddingClient(config);
  const result = await embedTexts(texts, client, {
    batchSize,
    onBatch: (stats) => {
      console.log(`批次 ${stats.index + 1}：${stats.count} 条，${stats.latencyMs}ms`);
    },
  });

  const createdAt = new Date().toISOString();
  const report = {
    createdAt,
    model: result.model,
    dimensions: result.dimensions,
    batchSize,
    count: result.items.length,
    usage: result.usage,
    latencyMs: result.latencyMs,
    batches: result.batches,
    items: result.items,
  };

  fs.mkdirSync(options.reportDir, { recursive: true });
  const reportFile = path.join(
    options.reportDir,
    `embeddings-${createdAt.replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const averageBatchLatency = Math.round(result.latencyMs / Math.max(result.batches.length, 1));
  console.log('');
  console.log(`完成：${result.items.length} 条，维度 ${result.dimensions}`);
  console.log(`Token：${result.usage.totalTokens}，批次平均耗时：${averageBatchLatency}ms`);
  console.log(`报告：${reportFile}`);
})().catch((error) => {
  if (error instanceof EmbeddingError) {
    console.error(`[${error.code}] ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
