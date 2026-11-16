/**
 * 文件作用：会话模块。
 *
 * imports: [AuthModule] —— 因为控制器用了 JwtAuthGuard，
 * 守卫需要 JwtService（AuthModule 已导出 JwtModule，见 Day 4 的踩坑记录）。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [AuthModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
