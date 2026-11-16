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

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/types/jwt-payload';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto, ListMessagesQueryDto, SendMessageDto } from './dto/conversation.dto';

@ApiTags('conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

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
  messages(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: ListMessagesQueryDto) {
    return this.conversations.listMessages(user.sub, id, query);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: '发送消息（role 固定为 USER）' })
  send(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.conversations.addMessage(user.sub, id, dto);
  }
}
