/**
 * 文件作用：系统配置模块 SystemModule。
 *
 * 关键概念：
 * 1. 结构与 HealthModule 类似：controllers + providers。
 * 2. SystemService 依赖 ConfigService，而 ConfigModule 在 AppModule 中设了 isGlobal:true，
 *    所以这里不需要再 imports ConfigModule 就能注入 ConfigService。
 */

import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
