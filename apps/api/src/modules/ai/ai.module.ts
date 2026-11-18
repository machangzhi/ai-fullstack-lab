import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { CHAT_TRANSPORT, OpenAiChatTransport } from './openai-chat.transport';

@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [
    AiService,
    {
      provide: CHAT_TRANSPORT,
      // 工厂方式避免 Nest 将测试用的可选构造参数当成 DI 依赖。
      useFactory: () => new OpenAiChatTransport(),
    },
  ],
})
export class AiModule {}
