/**
 * 文件作用：Embedding 配置解析（Week 5 Day 4）。
 *
 * 与聊天模型分开配置的原因：
 * - DeepSeek 聊天接口不提供 Embedding，Embedding 往往来自另一个供应商；
 * - 两者的模型名、维度、批量大小、限流规则都不同；
 * - 混用一套配置会导致「换聊天模型把索引维度换掉」这类事故。
 */

import { EmbeddingError } from './errors';

export interface EmbeddingConfig {
  apiKey: string;
  /** 已去掉末尾斜杠的 OpenAI 兼容地址。 */
  baseUrl: string;
  model: string;
  /** 请求时是否显式指定维度；null 表示使用模型默认维度。 */
  dimensions: number | null;
  /** 单次请求最多发送多少段文本。 */
  batchSize: number;
  timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_TIMEOUT_MS = 30_000;

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const apiKey = env.EMBEDDING_API_KEY?.trim();
  if (!apiKey) {
    throw new EmbeddingError('INVALID_CONFIG', '缺少 EMBEDDING_API_KEY，无法调用 Embedding 服务。');
  }

  const baseUrl = normalizeBaseUrl(env.EMBEDDING_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const model = env.EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  const dimensions = parseOptionalInt(env.EMBEDDING_DIMENSIONS, 'EMBEDDING_DIMENSIONS', 1, 8192);
  const batchSize =
    parseOptionalInt(env.EMBEDDING_BATCH_SIZE, 'EMBEDDING_BATCH_SIZE', 1, 128) ??
    DEFAULT_BATCH_SIZE;
  const timeoutMs =
    parseOptionalInt(env.EMBEDDING_TIMEOUT_MS, 'EMBEDDING_TIMEOUT_MS', 1000, 120_000) ??
    DEFAULT_TIMEOUT_MS;

  return { apiKey, baseUrl, model, dimensions, batchSize, timeoutMs };
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmbeddingError('INVALID_CONFIG', `EMBEDDING_BASE_URL 不是合法地址：${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EmbeddingError('INVALID_CONFIG', 'EMBEDDING_BASE_URL 只支持 http/https。');
  }
  if (url.username || url.password) {
    throw new EmbeddingError('INVALID_CONFIG', 'EMBEDDING_BASE_URL 不允许携带账号密码。');
  }

  return raw.replace(/\/+$/, '');
}

function parseOptionalInt(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EmbeddingError(
      'INVALID_CONFIG',
      `${name} 必须是 ${min}~${max} 之间的整数，当前为：${raw}`,
    );
  }
  return value;
}
