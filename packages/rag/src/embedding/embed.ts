/**
 * 文件作用：批量向量化（Week 5 Day 4）。
 *
 * Embedding 接口按「一次多条」计费，逐条调用既慢又浪费。这里把文本切批：
 * - 默认每批 16 条，可用 EMBEDDING_BATCH_SIZE 调整；
 * - 顺序发送，避免瞬时打满供应商限流；
 * - 记录每批耗时与 Token，最后汇总，便于估算索引成本。
 */

import { estimateTokens } from '../chunking/tokens';
import type { EmbeddingClient, EmbeddingUsage } from './client';
import { EmbeddingError } from './errors';

export interface EmbedTextsOptions {
  /** 每批文本数，默认 16。 */
  batchSize?: number;
  /** 每批完成后回调，用于 CLI 进度输出。 */
  onBatch?: (stats: BatchStats) => void;
}

export interface BatchStats {
  index: number;
  count: number;
  latencyMs: number;
  usage: EmbeddingUsage | null;
}

export interface EmbeddedText {
  index: number;
  text: string;
  vector: number[];
  /** 估算 Token，不是供应商返回的精确值。 */
  tokenCount: number;
}

export interface EmbedTextsResult {
  items: EmbeddedText[];
  model: string;
  dimensions: number;
  batches: BatchStats[];
  usage: EmbeddingUsage;
  /** 各批客户端耗时之和。 */
  latencyMs: number;
}

export async function embedTexts(
  texts: string[],
  client: EmbeddingClient,
  options: EmbedTextsOptions = {},
): Promise<EmbedTextsResult> {
  const batchSize = options.batchSize ?? 16;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new EmbeddingError('INVALID_INPUT', 'batchSize 必须是 1~256 的整数。');
  }
  if (texts.length === 0) {
    throw new EmbeddingError('INVALID_INPUT', '没有需要向量化的文本。');
  }

  const emptyIndex = texts.findIndex((text) => typeof text !== 'string' || !text.trim());
  if (emptyIndex !== -1) {
    throw new EmbeddingError('INVALID_INPUT', `第 ${emptyIndex} 条文本为空，无法向量化。`);
  }

  const items: EmbeddedText[] = [];
  const batches: BatchStats[] = [];
  const usage: EmbeddingUsage = { promptTokens: 0, totalTokens: 0 };
  let dimensions = 0;
  let model = '';
  let latencyMs = 0;

  for (let start = 0; start < texts.length; start += batchSize) {
    const batchTexts = texts.slice(start, start + batchSize);
    const response = await client.embed(batchTexts);

    if (response.embeddings.length !== batchTexts.length) {
      throw new EmbeddingError(
        'INVALID_RESPONSE',
        `Embedding 数量不匹配：请求 ${batchTexts.length} 条，返回 ${response.embeddings.length} 条`,
      );
    }

    batchTexts.forEach((text, offset) => {
      const vector = response.embeddings[offset];
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new EmbeddingError('INVALID_RESPONSE', `第 ${start + offset} 条向量为空`);
      }
      if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new EmbeddingError('INVALID_RESPONSE', `第 ${start + offset} 条向量包含非数值`);
      }
      if (dimensions === 0) dimensions = vector.length;
      if (vector.length !== dimensions) {
        throw new EmbeddingError(
          'INVALID_RESPONSE',
          `向量维度不一致：期望 ${dimensions}，实际 ${vector.length}`,
        );
      }

      items.push({
        index: start + offset,
        text,
        vector,
        tokenCount: estimateTokens(text),
      });
    });

    if (!model) model = response.model;
    if (response.usage) {
      usage.promptTokens += response.usage.promptTokens;
      usage.totalTokens += response.usage.totalTokens;
    }
    latencyMs += response.latencyMs;

    const stats: BatchStats = {
      index: batches.length,
      count: batchTexts.length,
      latencyMs: response.latencyMs,
      usage: response.usage,
    };
    batches.push(stats);
    options.onBatch?.(stats);
  }

  return {
    items,
    model: model || 'unknown',
    dimensions,
    batches,
    usage,
    latencyMs,
  };
}
