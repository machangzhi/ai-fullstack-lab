/**
 * 文件作用：会话与消息接口。
 *
 * 路由设计（REST 的资源归属）：
 *   POST   /api/conversations                   创建会话
 *   GET    /api/conversations                   我的会话列表
 *   GET    /api/conversations/:id               会话详情
 *   GET    /api/conversations/:id/messages      会话内消息（分页）
 *   POST   /api/conversations/:id/messages      发送消息
 *
 * 所有接口都要求登录（JwtAuthGuard），且 Service 内部再做归属校验。
 * 为什么 Guard 之外还要查 userId：Guard 只能证明"你是某个用户"，
 * 不能证明"这个会话是你的"。
 */

import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import { openSseResponse, writeSseEvent } from '../../common/http/sse';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/types/jwt-payload';
import { ConversationChatService } from './conversation-chat.service';
import { ConversationsService } from './conversations.service';
import {
  CreateConversationDto,
  ListMessagesQueryDto,
  SendMessageDto,
} from './dto/conversation.dto';

@ApiTags('conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly chat: ConversationChatService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建会话' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateConversationDto) {
    return this.conversations.create(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: '我的会话列表（按最近更新倒序）' })
  list(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.conversations.listMine(user.sub, Number(page) || 1, Number(pageSize) || 20);
  }

  @Get(':id')
  @ApiOperation({ summary: '会话详情' })
  detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.conversations.getOwned(user.sub, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: '会话内消息（升序分页）' })
  messages(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.conversations.listMessages(user.sub, id, query);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: '发送消息（role 固定为 USER）' })
  send(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.conversations.addMessage(user.sub, id, dto);
  }

  /**
   * 多轮流式对话：带历史上下文，回复落库并记录用量。
   * 与单轮 /ai/chat/stream 的区别是：这里必须先归属校验，历史只能来自当前会话。
   */
  @Post(':id/messages/stream')
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: '多轮流式对话（SSE，保存历史与用量）' })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ChatRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    openSseResponse(res);

    const abortController = new AbortController();
    const handleClose = (): void => abortController.abort();
    req.on('close', handleClose);

    try {
      for await (const event of this.chat.streamReply(
        user.sub,
        id,
        dto.message,
        dto.template ?? 'assistant',
        abortController.signal,
      )) {
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
