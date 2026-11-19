import type { EntityExtraction, FeedbackClassification } from '@ai-lab/ai-core';
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiService, type ChatReply, type StructuredReply } from './ai.service';
import { ChatRequestDto } from './dto/chat.dto';
import { StructuredTextDto } from './dto/structured-text.dto';

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

  @Post('classify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '把用户反馈分类为固定类别，输出经 Zod 校验' })
  @ApiOkResponse({ description: '已校验的分类结果、实际请求次数与 Token 用量' })
  classify(@Body() dto: StructuredTextDto): Promise<StructuredReply<FeedbackClassification>> {
    return this.aiService.classify(dto.text);
  }

  @Post('extract')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '从文本中抽取实体，输出经 Zod 校验' })
  @ApiOkResponse({ description: '已校验的实体列表、实际请求次数与 Token 用量' })
  extract(@Body() dto: StructuredTextDto): Promise<StructuredReply<EntityExtraction>> {
    return this.aiService.extractEntities(dto.text);
  }
}
