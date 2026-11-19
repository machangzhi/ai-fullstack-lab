import type { EntityExtraction, FeedbackClassification } from '@ai-lab/ai-core';
import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  AiService,
  type ChatReply,
  type ChatStreamServiceEvent,
  type StructuredReply,
} from './ai.service';
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
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 告诉 Nginx 不要缓冲，否则前端会等到整段结束才收到内容。
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abortController = new AbortController();
    const handleClose = (): void => abortController.abort();
    req.on('close', handleClose);

    try {
      for await (const event of this.aiService.streamChat(
        dto.message,
        dto.template,
        abortController.signal,
      )) {
        if (abortController.signal.aborted) {
          break;
        }
        this.writeEvent(res, event.type, event);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const safe =
          error instanceof AppError
            ? error
            : new AppError('模型服务暂时不可用，请稍后重试。', 'AI_PROVIDER_ERROR', 502);
        this.writeEvent(res, 'error', { code: safe.code, message: safe.message });
      }
    } finally {
      req.off('close', handleClose);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  /** 单条 SSE 事件格式：event 名称 + 一行 JSON data。写入失败说明连接已断，直接忽略。 */
  private writeEvent(
    res: Response,
    event: string,
    payload: ChatStreamServiceEvent | { code: string; message: string },
  ): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // 连接已关闭，无需再处理。
    }
  }
}
