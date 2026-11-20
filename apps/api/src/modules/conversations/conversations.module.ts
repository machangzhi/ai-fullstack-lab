/**
 * 文件作用：会话模块。
 *
 * imports: [AuthModule] —— 因为控制器用了 JwtAuthGuard，
 * 守卫需要 JwtService（AuthModule 已导出 JwtModule，见 Day 4 的踩坑记录）。
 */

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationChatService } from './conversation-chat.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [AuthModule, AiModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationChatService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
