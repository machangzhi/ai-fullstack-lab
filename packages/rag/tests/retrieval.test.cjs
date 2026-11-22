/**
 * 文件作用：验证检索策略的过滤、打分、混合融合与配置对比（Week 6 Day 1）。
 *
 * 全部使用固定候选集与手写相似度，不连接数据库、不调用 Embedding 服务，
 * 因而可以稳定复现不同 K / 阈值 / 过滤条件下的差异。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RetrievalError,
  compareRetrievalConfigs,
  keywordScore,
  matchesRetrievalFilters,
  searchCandidates,
  tokenizeForKeyword,
} = require('../dist/index.js');

function makeCandidate(overrides = {}) {
  return {
    chunkId: 't-01',
    documentId: 'doc-travel',
    documentTitle: '差旅管理制度',
    filename: 'travel-policy.md',
    format: 'markdown',
    content: '一线城市住宿标准为每晚六百元，二线城市每晚四百元。',
    sectionPath: ['差旅管理制度', '住宿标准'],
    page: null,
    similarity: 0.9,
    ...overrides,
  };
}

const CANDIDATES = [
  makeCandidate({ chunkId: 't-01', similarity: 0.9 }),
  makeCandidate({
    chunkId: 't-02',
    content: '住宿发票需列出房间单价和入住天数，发票抬头必须与公司名称一致。',
    sectionPath: ['差旅管理制度', '住宿标准', '发票要求'],
    similarity: 0.72,
  }),
  makeCandidate({
    chunkId: 't-03',
    content: '出差交通优先选择高铁二等座，单程超过六小时可以申请飞机经济舱。',
    sectionPath: ['差旅管理制度', '交通标准'],
    similarity: 0.44,
  }),
  makeCandidate({
    chunkId: 'p-03',
    documentId: 'doc-procure',
    documentTitle: '采购管理制度',
    filename: 'purchase-policy.pdf',
    format: 'pdf',
    content: '超过五万元的采购需提交采购委员会评审。',
    sectionPath: ['采购管理制度', '审批权限'],
    similarity: 0.35,
  }),
  makeCandidate({
    chunkId: 'h-01',
    documentId: 'doc-hr',
    documentTitle: '考勤与休假制度',
    filename: 'attendance.docx',
    format: 'docx',
    content: '入职满一年的员工每年享受五天年假。',
    sectionPath: ['考勤与休假制度', '年假'],
    similarity: 0.2,
  }),
];

describe('检索过滤条件', () => {
  test('文档、格式、标题、文件名与章节前缀都是硬约束', () => {
    const candidate = CANDIDATES[0];

    assert.equal(matchesRetrievalFilters(candidate), true);
    assert.equal(matchesRetrievalFilters(candidate, { documentIds: ['doc-travel'] }), true);
    assert.equal(matchesRetrievalFilters(candidate, { documentIds: ['doc-hr'] }), false);
    assert.equal(matchesRetrievalFilters(candidate, { formats: ['markdown'] }), true);
    assert.equal(matchesRetrievalFilters(candidate, { formats: ['pdf'] }), false);
    assert.equal(matchesRetrievalFilters(candidate, { filenameContains: 'POLICY' }), true);
    assert.equal(matchesRetrievalFilters(candidate, { titleContains: '采购' }), false);
    assert.equal(
      matchesRetrievalFilters(candidate, {
        sectionPathPrefix: ['差旅管理制度', '住宿标准'],
      }),
      true,
    );
    assert.equal(
      matchesRetrievalFilters(candidate, {
        sectionPathPrefix: ['差旅管理制度', '交通标准'],
      }),
      false,
    );
  });

  test('格式未知的片段会被格式过滤排除', () => {
    const candidate = makeCandidate({ format: null });
    assert.equal(matchesRetrievalFilters(candidate, { formats: ['markdown'] }), false);
  });
});

describe('关键词打分', () => {
  test('中文按二元组切分，英文按词切分', () => {
    const tokens = tokenizeForKeyword('住宿标准 BM25');
    assert.ok(tokens.includes('住宿'));
    assert.ok(tokens.includes('宿标'));
    assert.ok(tokens.includes('标准'));
    assert.ok(tokens.includes('bm25'));
  });

  test('关键词覆盖率在 0~1 之间，命中越多分数越高', () => {
    const exact = keywordScore('住宿标准', '住宿标准按城市等级执行');
    const partial = keywordScore('住宿标准', '住宿发票需要列明单价');
    const none = keywordScore('年假', '采购需要三家比价');

    assert.equal(exact, 1);
    assert.ok(partial > 0 && partial < 1);
    assert.equal(none, 0);
  });
});

describe('Top-K 与阈值', () => {
  test('按相似度降序返回 Top-K，并附上名次', () => {
    const hits = searchCandidates(CANDIDATES, '住宿标准', { topK: 3 });

    assert.deepEqual(
      hits.map((hit) => hit.chunkId),
      ['t-01', 't-02', 't-03'],
    );
    assert.deepEqual(
      hits.map((hit) => hit.rank),
      [1, 2, 3],
    );
    assert.equal(hits[0].score, 0.9);
  });

  test('阈值过滤会减少命中数，K 不补位', () => {
    const all = searchCandidates(CANDIDATES, '住宿标准', { topK: 5 });
    const strict = searchCandidates(CANDIDATES, '住宿标准', {
      topK: 5,
      minSimilarity: 0.5,
    });

    assert.equal(all.length, 5);
    assert.deepEqual(
      strict.map((hit) => hit.chunkId),
      ['t-01', 't-02'],
    );
  });

  test('先过滤再截断，避免无关文档占用名次', () => {
    const hits = searchCandidates(CANDIDATES, '住宿标准', {
      topK: 2,
      minSimilarity: 0.3,
      filters: { documentIds: ['doc-travel'] },
    });

    assert.deepEqual(
      hits.map((hit) => hit.chunkId),
      ['t-01', 't-02'],
    );
  });
});

describe('关键词与混合检索', () => {
  test('纯关键词模式按覆盖率排序，不应用向量阈值', () => {
    const hits = searchCandidates(CANDIDATES, '采购委员会评审', {
      mode: 'keyword',
      topK: 2,
      minSimilarity: 0.99,
    });

    assert.equal(hits[0].chunkId, 'p-03');
    assert.ok(hits[0].keywordScore > 0);
    assert.equal(hits[0].score, hits[0].keywordScore);
  });

  test('加权融合同时考虑向量与关键词分数', () => {
    const hits = searchCandidates(CANDIDATES, '住宿标准', {
      mode: 'hybrid',
      fusion: 'weighted',
      vectorWeight: 0.5,
      topK: 2,
    });

    assert.equal(hits.length, 2);
    assert.ok(hits[0].keywordScore > 0);
    assert.ok(hits[0].score > 0.5);
  });

  test('RRF 用名次融合，分数在 (0, 1) 之间且排序稳定', () => {
    const hits = searchCandidates(CANDIDATES, '住宿标准', {
      mode: 'hybrid',
      fusion: 'rrf',
      vectorWeight: 0.7,
      topK: 3,
    });

    assert.equal(hits.length, 3);
    for (const hit of hits) {
      assert.ok(hit.score > 0 && hit.score < 1);
    }
    assert.equal(hits[0].rank, 1);
  });
});

describe('参数校验', () => {
  test('非法 Top-K、阈值、模式与权重直接失败', () => {
    const cases = [
      { topK: 0 },
      { topK: 51 },
      { topK: 1.5 },
      { minSimilarity: -0.1 },
      { minSimilarity: 1.2 },
      { mode: 'unknown' },
      { mode: 'hybrid', fusion: 'unknown' },
      { mode: 'hybrid', vectorWeight: 1.5 },
      { mode: 'hybrid', rrfK: 0 },
    ];

    for (const options of cases) {
      assert.throws(
        () => searchCandidates(CANDIDATES, '住宿', options),
        (error) => error instanceof RetrievalError && error.code === 'INVALID_INPUT',
        `应拒绝：${JSON.stringify(options)}`,
      );
    }

    assert.throws(
      () => searchCandidates(CANDIDATES, '   '),
      (error) => error instanceof RetrievalError,
    );
  });
});

describe('配置对比', () => {
  const datasets = [
    { query: '住宿标准', candidates: CANDIDATES },
    { query: '采购审批', candidates: CANDIDATES },
  ];

  test('输出每个配置的命中率、重合度与逐查询结果', () => {
    const report = compareRetrievalConfigs(datasets, [
      { name: 'baseline', options: { topK: 5, minSimilarity: 0 } },
      { name: 'strict', options: { topK: 2, minSimilarity: 0.5 } },
    ]);

    assert.equal(report.baseline, 'baseline');
    assert.equal(report.configs.length, 2);

    const [baseline, strict] = report.configs;
    assert.equal(baseline.queryCount, 2);
    assert.equal(baseline.queriesWithHits, 2);
    assert.equal(baseline.baselineOverlap, 1);
    assert.equal(baseline.top1SameRate, 1);

    assert.equal(strict.avgHitsPerQuery, 2);
    assert.ok(strict.baselineOverlap > 0 && strict.baselineOverlap < 1);
    assert.equal(strict.top1SameRate, 1);
    assert.equal(strict.perQuery.length, 2);
  });

  test('空查询集或空配置直接失败', () => {
    assert.throws(
      () => compareRetrievalConfigs([], [{ name: 'a', options: {} }]),
      (error) => error instanceof RetrievalError,
    );
    assert.throws(
      () => compareRetrievalConfigs(datasets, []),
      (error) => error instanceof RetrievalError,
    );
  });
});
