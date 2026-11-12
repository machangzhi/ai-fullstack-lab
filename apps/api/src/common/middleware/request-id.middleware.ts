/**
 * 文件作用：请求 ID 中间件（函数式）。
 *
 * 关键概念：
 * 1. 为什么需要 requestId？—— 一次请求可能经过多层逻辑（中间件 → 控制器 → 服务 → 外部调用），
 *    给每个请求分配唯一 ID，能把散落的日志串起来，排查问题时一眼定位。
 * 2. 优先复用调用方传入的 x-request-id —— 如果上游（网关/前端）已经传了 ID，就沿用它，
 *    这样整条链路（前端 → 本服务 → 下游服务）用同一个 ID，方便分布式追踪。
 * 3. 同时把 requestId 回写到响应头 x-request-id，前端拿到后可在错误提示中展示给用户报障。
 * 4. 这里用函数式中间件（而非 NestMiddleware 类），是因为它不需要依赖注入，更简洁。
 */

// randomUUID：Node 内置的 UUID v4 生成，无需安装 uuid 包。
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * 为每个请求生成 requestId，优先复用调用方传入的 x-request-id。
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 读取请求头中的 x-request-id，trim 去除首尾空格。
  const incoming = req.header('x-request-id')?.trim();
  // 有就用上游的，没有就自己生成一个 UUID。
  req.requestId = incoming || randomUUID();
  // 把 requestId 写回响应头，前端/网关可以拿到。
  res.setHeader('x-request-id', req.requestId);
  // 调用 next() 把控制权交给下一个中间件或路由处理器。
  next();
}
