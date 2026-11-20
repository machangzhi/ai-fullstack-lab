/**
 * 文件作用：SSE 响应的公共写入逻辑（Week 3 Day 5 起使用，Day 6 被两个控制器复用）。
 *
 * 关键约束：
 * 1. 一旦 flushHeaders()，HTTP 状态码就固定为 200，后续错误只能通过 error 事件表达。
 * 2. 客户端可能随时断开，res.write 失败必须吞掉，不能把异常抛回框架。
 */

import type { Response } from 'express';

/** 设置 SSE 头并立即发送，让浏览器尽早进入接收状态。 */
export function openSseResponse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 告诉 Nginx 不要缓冲，否则前端会等到整段结束才收到内容。
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** 写一条事件：event 名称 + 单行 JSON。连接已断时静默忽略。 */
export function writeSseEvent(res: Response, event: string, payload: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // 连接已关闭，无需再处理。
  }
}
