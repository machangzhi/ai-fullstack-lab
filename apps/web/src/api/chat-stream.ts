/**
 * 文件作用：浏览器端 SSE 客户端（Week 3 Day 5）。
 *
 * 为什么不用 axios：axios 在浏览器里会把响应体读完才返回，拿不到"边到边渲染"的效果。
 * fetch + ReadableStream 才能逐块读取，配合 TextDecoder 处理跨块的多字节字符。
 *
 * SSE 报文按空行分隔，每条事件形如：
 *   event: delta
 *   data: {"type":"delta","content":"你"}
 *
 * 解析要点：
 * 1. 网络分块不保证按事件边界切分，必须自己维护 buffer。
 * 2. 使用 stream: true 解码，避免一个中文字符被切在两个 Uint8Array 里变成乱码。
 * 3. 服务端已返回 200 后无法再改状态码，业务错误改为 error 事件下发。
 */

import { ApiClientError } from './client';

export interface ChatStreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatStreamMeta {
  /** 公开模型档案 ID，例如 deepseek-chat / deepseek-reasoner。 */
  modelId?: string;
  model: string;
  template: string;
  usage: ChatStreamUsage | null;
  /** 多轮会话才有：服务端返回的会话 ID 与自动生成的标题。 */
  conversationId?: string;
  title?: string;
}

export interface ChatStreamOptions {
  message: string;
  template: string;
  /** 模型档案 ID；不传时由服务端使用默认档案。 */
  model?: string;
  /** 传入时走多轮会话接口，回复会落库；不传则走单轮接口。 */
  conversationId?: string;
  token: string | null;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onMeta: (meta: ChatStreamMeta) => void;
  /** access token 过期时用来换新令牌；不传则直接抛 401。 */
  refreshToken?: () => Promise<string | null>;
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

interface ParsedEvent {
  event: string;
  data: unknown;
}

function parseBlock(block: string): ParsedEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

async function openStream(options: ChatStreamOptions, token: string | null): Promise<Response> {
  const path = options.conversationId
    ? `/conversations/${encodeURIComponent(options.conversationId)}/messages/stream`
    : '/ai/chat/stream';

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message: options.message,
      template: options.template,
      ...(options.model ? { model: options.model } : {}),
    }),
    signal: options.signal,
  });

  if (response.ok && response.body) {
    return response;
  }

  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;

  throw new ApiClientError(
    payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
    payload?.error?.code ?? 'NETWORK_ERROR',
    response.status,
  );
}

async function consume(response: Response, options: ChatStreamOptions): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ApiClientError('浏览器不支持流式响应。', 'STREAM_UNSUPPORTED', 0);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseBlock(block);

        if (parsed?.event === 'delta') {
          options.onDelta((parsed.data as { content: string }).content);
        } else if (parsed?.event === 'meta') {
          options.onMeta(parsed.data as ChatStreamMeta);
        } else if (parsed?.event === 'error') {
          const error = parsed.data as { code: string; message: string };
          throw new ApiClientError(error.message, error.code, 0);
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 打开流并逐事件回调；401 时先用 refresh token 换新令牌再重试一次。 */
export async function streamChat(options: ChatStreamOptions): Promise<void> {
  try {
    await consume(await openStream(options, options.token), options);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401 && options.refreshToken) {
      const nextToken = await options.refreshToken();
      if (!nextToken) throw error;
      await consume(await openStream(options, nextToken), options);
      return;
    }
    throw error;
  }
}
