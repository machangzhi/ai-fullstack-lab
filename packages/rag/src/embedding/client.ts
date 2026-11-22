/**
 * 文件作用：OpenAI 兼容 Embeddings 客户端（Week 5 Day 4）。
 *
 * 协议只有一步：POST /embeddings，发送文本数组，拿回等长的向量数组。
 * 这里重点做三件事：
 * 1. 请求体只包含模型、输入与可选维度，密钥只放 Authorization；
 * 2. 校验响应数量、索引与维度，防止「少一条向量」静默错位；
 * 3. 错误统一包装成 EmbeddingError，日志里不出现密钥。
 */

import type { EmbeddingConfig } from './config';
import { EmbeddingError } from './errors';

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbeddingResponse {
  /** 与请求文本顺序一致的向量。 */
  embeddings: number[][];
  model: string;
  usage: EmbeddingUsage | null;
  latencyMs: number;
}

export interface EmbeddingClient {
  embed(texts: string[]): Promise<EmbeddingResponse>;
}

export interface EmbeddingClientOptions {
  /** 测试注入用；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入用；默认 Date.now。 */
  now?: () => number;
}

export function createEmbeddingClient(
  config: EmbeddingConfig,
  options: EmbeddingClientOptions = {},
): EmbeddingClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  return {
    async embed(texts: string[]): Promise<EmbeddingResponse> {
      if (texts.length === 0) {
        throw new EmbeddingError('INVALID_INPUT', '没有需要向量化的文本。');
      }

      const body: Record<string, unknown> = {
        model: config.model,
        input: texts,
        encoding_format: 'float',
      };
      if (config.dimensions !== null) {
        body.dimensions = config.dimensions;
      }

      const startedAt = now();
      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EmbeddingError('REQUEST_FAILED', `Embedding 请求失败：${message}`, error);
      }
      const latencyMs = now() - startedAt;

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EmbeddingError('REQUEST_FAILED', `读取 Embedding 响应失败：${message}`, error);
      }

      if (!response.ok) {
        throw new EmbeddingError(
          'HTTP_ERROR',
          `Embedding 服务返回 HTTP ${response.status}`,
          truncate(raw),
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new EmbeddingError('INVALID_RESPONSE', 'Embedding 响应不是合法 JSON', truncate(raw));
      }

      return parseResponse(payload, texts.length, config.model, latencyMs);
    },
  };
}

function parseResponse(
  payload: unknown,
  expectedCount: number,
  fallbackModel: string,
  latencyMs: number,
): EmbeddingResponse {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new EmbeddingError('INVALID_RESPONSE', 'Embedding 响应缺少 data 数组');
  }

  if (payload.data.length !== expectedCount) {
    throw new EmbeddingError(
      'INVALID_RESPONSE',
      `Embedding 数量不匹配：请求 ${expectedCount} 条，返回 ${payload.data.length} 条`,
    );
  }

  const items = payload.data.map((item, position) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new EmbeddingError('INVALID_RESPONSE', `第 ${position} 条 Embedding 缺少向量`);
    }

    const index = typeof item.index === 'number' ? item.index : position;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new EmbeddingError('INVALID_RESPONSE', `Embedding 索引非法：${String(item.index)}`);
    }

    const embedding = item.embedding.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingError('INVALID_RESPONSE', 'Embedding 向量包含非数值');
      }
      return value;
    });
    if (embedding.length === 0) {
      throw new EmbeddingError('INVALID_RESPONSE', 'Embedding 向量为空');
    }

    return { index, embedding };
  });

  items.sort((left, right) => left.index - right.index);
  items.forEach((item, position) => {
    if (item.index !== position) {
      throw new EmbeddingError('INVALID_RESPONSE', `Embedding 索引缺失或重复：${item.index}`);
    }
  });

  const dimensions = items[0].embedding.length;
  if (items.some((item) => item.embedding.length !== dimensions)) {
    throw new EmbeddingError('INVALID_RESPONSE', '同一批 Embedding 的维度不一致');
  }

  return {
    embeddings: items.map((item) => item.embedding),
    model:
      typeof payload.model === 'string' && payload.model.trim() ? payload.model : fallbackModel,
    usage: parseUsage(payload.usage),
    latencyMs,
  };
}

function parseUsage(value: unknown): EmbeddingUsage | null {
  if (!isRecord(value)) return null;

  const promptTokens = toNonNegativeInt(value.prompt_tokens);
  const totalTokens = toNonNegativeInt(value.total_tokens);
  if (promptTokens === null && totalTokens === null) return null;

  return {
    promptTokens: promptTokens ?? 0,
    totalTokens: totalTokens ?? promptTokens ?? 0,
  };
}

function toNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxLength = 300): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
