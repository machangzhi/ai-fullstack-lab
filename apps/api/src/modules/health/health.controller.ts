/**
 * 文件作用：健康检查控制器 HealthController。
 *
 * 关键概念：
 * 1. @Controller('health') —— 声明这个类处理 /health 前缀的路由。
 *    配合 main.ts 的 setGlobalPrefix('api')，最终路径是 /api/health。
 * 2. @Get() —— 处理 GET 请求。不带参数表示匹配根路径 /api/health。
 * 3. @ApiTags('health') —— Swagger 文档分组标签，所有接口归类到 health 组下。
 * 4. @ApiOperation / @ApiOkResponse —— Swagger 注解，给接口加描述和响应说明。
 * 5. 构造函数注入 HealthService —— NestJS 自动把 HealthService 实例传进来，
 *    不用自己 new，这就是依赖注入（DI）。
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService, HealthStatus } from './health.service';

@ApiTags('health') // Swagger 分组
@Controller('health') // 路由前缀 /health
export class HealthController {
  // 构造函数注入：NestJS 自动创建 HealthService 并传入。
  constructor(private readonly healthService: HealthService) {}

  @Get() // GET /api/health
  @ApiOperation({ summary: '健康检查' })
  @ApiOkResponse({ description: '服务正常' })
  getStatus(): HealthStatus {
    return this.healthService.getStatus();
  }
}
