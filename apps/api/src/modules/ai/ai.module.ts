import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { LlmService } from './llm.service';
import { CHAT_TRANSPORT } from './openai-chat.transport';
import { ReliableChatTransport } from './reliability/reliable-chat.transport';
import { ToolChatService } from './tools/tool-chat.service';
import { ToolRegistry } from './tools/tool-registry.service';
import { UsageService } from './usage.service';

@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [
    AiService,
    UsageService,
    ToolRegistry,
    ToolChatService,
    {
      provide: LlmService,
      // 工厂方式避免 Nest 把用于测试注入的 env / createClient 参数当成 DI 依赖。
      useFactory: () => new LlmService(),
    },
    {
      provide: CHAT_TRANSPORT,
      // 业务层只依赖 ChatTransport：外层可靠性包装（超时/重试/并发/熔断）在装配时叠加。
      useFactory: (llm: LlmService) => ReliableChatTransport.fromEnv(llm),
      inject: [LlmService],
    },
  ],
  exports: [AiService],
})
export class AiModule {}
