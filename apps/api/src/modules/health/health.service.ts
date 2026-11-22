/**
 * 文件作用：健康检查服务 HealthService。
 *
 * 关键概念：
 * 1. 健康检查接口的作用 —— 给负载均衡器/容器编排/监控系统用，判断服务是否存活。
 *    一般返回 200 + 简单状态信息，不做复杂逻辑（否则健康检查本身可能拖垮服务）。
 * 2. @Injectable() —— 标记这个类可被 NestJS 的 DI 容器实例化并注入到 Controller。
 * 3. process.uptime() —— Node 进程已运行的秒数。
 * 4. APP_VERSION 从环境变量读，默认 '1.0.0'，和 package.json 版本对应。
 * 5. timestamp 用 ISO 字符串，前端可以直接 new Date(...) 解析。
 */

import { Injectable } from '@nestjs/common';

// 健康状态返回结构。
export interface HealthStatus {
  status: 'ok'; // 固定 'ok'，后续可扩展 'degraded' 等状态。
  uptime: number; // 进程运行秒数
  version: string; // 应用版本
  timestamp: string; // 检查时间（ISO 字符串）
}

@Injectable()
export class HealthService {
  getStatus(): HealthStatus {
    return {
      status: 'ok',
      // process.uptime() 返回秒数（浮点数），取整。
      uptime: Math.floor(process.uptime()),
      version: process.env.APP_VERSION ?? '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
