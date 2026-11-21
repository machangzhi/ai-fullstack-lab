import type { EntityExtraction, FeedbackClassification } from '@ai-lab/ai-core';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import { openSseResponse, writeSseEvent } from '../../common/http/sse';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/types/jwt-payload';
import { AiService, type ChatReply, type StructuredReply } from './ai.service';
import { ChatRequestDto } from './dto/chat.dto';
import { StructuredTextDto } from './dto/structured-text.dto';
import { ToolChatRequestDto } from './dto/tool-chat.dto';
import type { ModelCatalog } from './openai-chat.transport';
import { ToolChatService, type ToolChatReply } from './tools/tool-chat.service';
import { UsageService, type UsageSummary } from './usage.service';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly tools: ToolChatService,
    private readonly usage: UsageService,
  ) {}

  @Get('models')
  @ApiOperation({ summary: '可切换的模型列表（不含地址与密钥）' })
  models(): ModelCatalog {
    return this.aiService.listModels();
  }

  @Get('usage')
  @ApiOperation({ summary: '我的今日用量与最近 10 次模型调用' })
  usageSummary(@CurrentUser() user: JwtPayload): Promise<UsageSummary> {
    return this.usage.summary(user.sub);
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '按 Prompt 模板发送单轮问题并获取 DeepSeek 非流式回复' })
  @ApiOkResponse({ description: '模型回复、实际模板、模型档案、模型名与 Token 用量' })
  chat(@Body() dto: ChatRequestDto): Promise<ChatReply> {
    return this.aiService.chat(dto.message, dto.template, dto.model);
  }

  @Post('tools/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '使用工具（当前时间 / 计算器）完成一次多轮工具调用' })
  @ApiOkResponse({ description: '最终回复、工具执行轨迹、轮次与累计 Token 用量' })
  toolsChat(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ToolChatRequestDto,
  ): Promise<ToolChatReply> {
    return this.tools.chat(user.sub, dto.message, dto.model);
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

  /**
   * SSE 流式对话。
   *
   * 关键点：
   * 1. 用 @Res() 直接写响应，绕开统一 JSON 外壳——SSE 不是一次性 JSON，无法被包装。
   * 2. 客户端断开时 req 触发 close，AbortController 会取消上游模型请求，避免继续计费。
   * 3. 响应头发出后 HTTP 状态码已固定为 200，因此模型错误只能作为 error 事件下发。
   */
  @Post('chat/stream')
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: '流式发送单轮问题（SSE）' })
  async chatStream(
    @Body() dto: ChatRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    openSseResponse(res);

    const abortController = new AbortController();
    const handleClose = (): void => abortController.abort();
    req.on('close', handleClose);

    try {
      for await (const event of this.aiService.streamChat(dto.message, dto.template, {
        signal: abortController.signal,
        profileId: dto.model,
      })) {
        if (abortController.signal.aborted) {
          break;
        }
        writeSseEvent(res, event.type, event);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const safe =
          error instanceof AppError
            ? error
            : new AppError('模型服务暂时不可用，请稍后重试。', 'AI_PROVIDER_ERROR', 502);
        writeSseEvent(res, 'error', { code: safe.code, message: safe.message });
      }
    } finally {
      req.off('close', handleClose);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
