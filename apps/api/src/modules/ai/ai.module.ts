import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { LlmService } from './llm.service';
import { CHAT_TRANSPORT } from './openai-chat.transport';
import { UsageService } from './usage.service';

@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [
    AiService,
    UsageService,
    {
      provide: LlmService,
      // 工厂方式避免 Nest 把用于测试注入的 env / createClient 参数当成 DI 依赖。
      useFactory: () => new LlmService(),
    },
    {
      provide: CHAT_TRANSPORT,
      // AiService 只依赖 ChatTransport 接口；测试可注入假实现，运行时落到多档案 LlmService。
      useExisting: LlmService,
    },
  ],
  exports: [AiService],
})
export class AiModule {}
