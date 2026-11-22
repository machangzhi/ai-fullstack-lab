#!/usr/bin/env node
/**
 * 文件作用：生成检索策略对比报告（Week 6 Day 1）。
 *
 * 用法：
 *   pnpm --filter @ai-lab/rag compare:retrieval
 *   pnpm --filter @ai-lab/rag compare:retrieval -- --input evals/datasets/retrieval-candidates.json
 *
 * 输入是一份「查询 + 候选片段 + 向量相似度」的数据集：
 * - 在线环境可以用 /api/knowledge/search 的结果导出成同样结构；
 * - 离线时使用仓库内的合成示例，验证对比流程是否工作。
 *
 * 产物：packages/rag/reports/retrieval-strategy.md（本地报告，默认不入库）。
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');
const DEFAULT_INPUT = path.join(PACKAGE_ROOT, 'evals', 'datasets', 'retrieval-candidates.json');
const DEFAULT_REPORT = path.join(PACKAGE_ROOT, 'reports', 'retrieval-strategy.md');

const {
  compareRetrievalConfigs,
  searchCandidates,
} = require('../dist/index.js');

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, report: DEFAULT_REPORT };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      options.input = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (arg === '--report') {
      options.report = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    }
  }

  return options;
}

function loadDataset(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Array.isArray(payload.documents) || !Array.isArray(payload.chunks)) {
    throw new Error('数据集缺少 documents 或 chunks 数组');
  }
  if (!Array.isArray(payload.queries) || payload.queries.length === 0) {
    throw new Error('数据集缺少 queries 数组');
  }

  const documents = new Map(payload.documents.map((document) => [document.documentId, document]));
  const chunks = new Map();

  for (const chunk of payload.chunks) {
    const document = documents.get(chunk.documentId);
    if (!document) {
      throw new Error(`切片 ${chunk.chunkId} 引用了不存在的文档 ${chunk.documentId}`);
    }
    chunks.set(chunk.chunkId, {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentTitle: document.title,
      filename: document.filename,
      format: document.format,
      content: chunk.content,
      sectionPath: chunk.sectionPath ?? [],
      page: chunk.page ?? null,
      similarity: 0,
    });
  }

  const datasets = payload.queries.map((entry) => ({
    query: entry.query,
    candidates: Object.entries(entry.scores ?? {}).map(([chunkId, similarity]) => {
      const chunk = chunks.get(chunkId);
      if (!chunk) throw new Error(`查询「${entry.query}」引用了不存在的切片 ${chunkId}`);
      return { ...chunk, similarity };
    }),
  }));

  return {
    name: payload.name ?? path.basename(file),
    description: payload.description ?? '',
    datasets,
  };
}

function buildConfigs() {
  const topKs = [1, 3, 5, 10];
  const thresholds = [0, 0.3, 0.5, 0.7, 0.85];

  const baseline = {
    name: 'K=5 / T=0',
    options: { mode: 'vector', topK: 5, minSimilarity: 0 },
  };

  const grid = [baseline];
  for (const topK of topKs) {
    for (const threshold of thresholds) {
      if (topK === 5 && threshold === 0) continue;
      grid.push({
        name: `K=${topK} / T=${threshold}`,
        options: { mode: 'vector', topK, minSimilarity: threshold },
      });
    }
  }

  const modes = [
    {
      name: 'vector / K=5 / T=0.3',
      options: { mode: 'vector', topK: 5, minSimilarity: 0.3 },
    },
    {
      name: 'keyword / K=5',
      options: { mode: 'keyword', topK: 5 },
    },
    {
      name: 'hybrid-weighted / 0.7',
      options: {
        mode: 'hybrid',
        fusion: 'weighted',
        vectorWeight: 0.7,
        topK: 5,
        minSimilarity: 0.3,
      },
    },
    {
      name: 'hybrid-rrf / 0.7',
      options: {
        mode: 'hybrid',
        fusion: 'rrf',
        vectorWeight: 0.7,
        topK: 5,
        minSimilarity: 0.3,
      },
    },
  ];

  return { baseline, grid, modes };
}

const formatPercent = (value) => `${(value * 100).toFixed(0)}%`;
const formatNumber = (value, digits = 2) =>
  value === null || value === undefined ? '—' : value.toFixed(digits);

function renderConfigTable(rows, includeMode = false) {
  const header = includeMode
    ? '| 配置 | 模式 | 平均命中数 | 有命中查询 | 平均 Top-1 相似度 | 与基线重合度 | Top-1 一致率 |'
    : '| 配置 | K | 阈值 | 平均命中数 | 有命中查询 | 平均 Top-1 相似度 | 与基线重合度 | Top-1 一致率 |';

  const separator = includeMode
    ? '| --- | --- | --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- | --- | --- | --- | --- |';

  const lines = rows.map((row) => {
    const shared = [
      formatNumber(row.avgHitsPerQuery),
      `${row.queriesWithHits}/${row.queryCount}`,
      formatNumber(row.avgTop1Similarity, 3),
      formatPercent(row.baselineOverlap),
      formatPercent(row.top1SameRate),
    ];

    if (includeMode) {
      return `| ${row.name} | ${row.mode} | ${shared.join(' | ')} |`;
    }

    return `| ${row.name} | ${row.topK} | ${row.minSimilarity} | ${shared.join(' | ')} |`;
  });

  return [header, separator, ...lines].join('\n');
}

function renderFilterDemo(dataset) {
  const cases = [
    { label: '无过滤', options: { topK: 5, minSimilarity: 0.3 } },
    {
      label: '章节前缀 ["差旅管理制度", "住宿标准"]',
      options: {
        topK: 5,
        minSimilarity: 0.3,
        filters: { sectionPathPrefix: ['差旅管理制度', '住宿标准'] },
      },
    },
    {
      label: '格式 = pdf',
      options: { topK: 5, minSimilarity: 0.3, filters: { formats: ['pdf'] } },
    },
    {
      label: '文档 = doc-hr（考勤与休假制度）',
      options: {
        topK: 5,
        minSimilarity: 0.3,
        filters: { documentIds: ['doc-hr'] },
      },
    },
  ];

  const lines = ['| 过滤条件 | 命中数 | Top-1 片段 | Top-1 相似度 |', '| --- | --- | --- | --- |'];

  for (const entry of cases) {
    const hits = searchCandidates(dataset.candidates, dataset.query, entry.options);
    const top = hits[0];
    lines.push(
      `| ${entry.label} | ${hits.length} | ${top ? `${top.chunkId}（${top.documentTitle}）` : '—'} | ${top ? top.similarity.toFixed(3) : '—'} |`,
    );
  }

  return lines.join('\n');
}

function renderReport(dataset, configs, comparison) {
  const gridRows = comparison.configs
    .filter((row) => configs.grid.some((config) => config.name === row.name))
    .sort((left, right) => left.topK - right.topK || left.minSimilarity - right.minSimilarity);
  const modeRows = comparison.configs.filter((row) =>
    configs.modes.some((config) => config.name === row.name),
  );

  const demoDataset = dataset.datasets[0];

  return [
    '# Week 6 Day 1：检索策略对比报告',
    '',
    `> 数据集：\`${dataset.name}\``,
    `> 基线配置：\`${comparison.baseline}\``,
    `> 生成时间：${new Date().toISOString()}`,
    '',
    '## 一、数据说明',
    '',
    dataset.description,
    '',
    `- 查询数：${dataset.datasets.length}`,
    `- 文档数：${new Set(dataset.datasets.flatMap((entry) => entry.candidates.map((item) => item.documentId))).size}`,
    `- 候选片段数（去重）：${new Set(dataset.datasets.flatMap((entry) => entry.candidates.map((item) => item.chunkId))).size}`,
    '',
    '## 二、Top-K × 相似度阈值',
    '',
    renderConfigTable(gridRows),
    '',
    '## 三、检索模式对比',
    '',
    renderConfigTable(modeRows, true),
    '',
    '## 四、过滤条件对比',
    '',
    `查询：\`${demoDataset.query}\`，K=5，阈值=0.3。`,
    '',
    renderFilterDemo(demoDataset),
    '',
    '## 五、如何解读',
    '',
    '- **K 变大**：平均命中数上升，但新增的通常是低相似度尾部；Top-1 一致率高说明头部稳定。',
    '- **阈值变高**：低分候选被排掉，命中数下降；阈值过高会让部分问题变成零命中，需要配合拒答策略。',
    '- **与基线重合度**：衡量配置变化对结果集的影响；重合度低不代表更好，只代表结果差异大。',
    '- **过滤条件**：是硬约束，会直接改变候选池；格式过滤可能把语义最相似的片段排除，因此要由业务明确范围。',
    '- **混合检索**：关键词负责精确字面命中，向量负责语义泛化；RRF 只看名次，不需要统一量纲。',
    '',
  ].join('\n');
}

(function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataset = loadDataset(options.input);
  const configs = buildConfigs();
  const allConfigs = [configs.baseline, ...configs.grid.filter((item) => item !== configs.baseline), ...configs.modes];
  const comparison = compareRetrievalConfigs(dataset.datasets, allConfigs);

  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.report, renderReport(dataset, configs, comparison));

  console.log(`数据集：${dataset.name}（${dataset.datasets.length} 条查询）`);
  console.log(`基线：${comparison.baseline}`);
  for (const row of comparison.configs) {
    console.log(
      `${row.name}：平均命中 ${row.avgHitsPerQuery.toFixed(2)}，` +
        `有命中 ${row.queriesWithHits}/${row.queryCount}，` +
        `Top-1 相似度 ${formatNumber(row.avgTop1Similarity, 3)}，` +
        `重合度 ${formatPercent(row.baselineOverlap)}`,
    );
  }
  console.log(`报告：${options.report}`);
})();
