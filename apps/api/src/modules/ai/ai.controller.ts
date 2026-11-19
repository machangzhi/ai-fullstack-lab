import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiService, type ChatReply } from './ai.service';
import { ChatRequestDto } from './dto/chat.dto';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '按 Prompt 模板发送单轮问题并获取 DeepSeek 非流式回复' })
  @ApiOkResponse({ description: '模型回复、实际模板、模型名与 Token 用量' })
  chat(@Body() dto: ChatRequestDto): Promise<ChatReply> {
    return this.aiService.chat(dto.message, dto.template);
  }
}
