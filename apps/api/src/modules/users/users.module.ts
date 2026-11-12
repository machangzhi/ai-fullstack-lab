/**
 * 文件作用：用户模块 UsersModule。
 *
 * 关键概念：
 * 1. 比 HealthModule 多了 exports —— 把 UsersService 暴露出去，
 *    后续鉴权模块（第 2 周 AuthModule）需要查询用户来校验登录，会 imports UsersModule 并注入 UsersService。
 * 2. 现在 exports 虽然暂时没被其他模块用，但提前写好是好习惯。
 */

import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  // 导出 UsersService，供其他模块（如第 2 周的 AuthModule）注入使用。
  exports: [UsersService],
})
export class UsersModule {}
