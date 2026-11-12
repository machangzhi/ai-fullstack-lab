/**
 * 文件作用：健康检查模块 HealthModule。
 *
 * 关键概念：
 * 1. NestJS 模块三件套：
 *    - controllers：处理 HTTP 请求的类（HealthController）。
 *    - providers：被 DI 容器管理的服务（HealthService）。
 *    - exports：本模块对外暴露的提供者，其他模块 imports 本模块后可以注入这些服务。
 * 2. 健康检查模块不需要 exports，因为没有其他模块依赖 HealthService。
 * 3. 在 AppModule 的 imports 中注册本模块后，/api/health 路由才会生效。
 */

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
