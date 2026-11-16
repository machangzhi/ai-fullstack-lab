/**
 * 文件作用：会话与消息的业务逻辑。
 *
 * 关键概念：
 * 1. **归属校验**是这里最重要的职责。所有会话操作都必须带 userId 条件，
 *    否则只要猜到别人的会话 id 就能读取/写入——这就是 IDOR（越权访问）漏洞。
 *    统一用 findFirst({ where: { id, userId } })，把"存在"和"属于你"合成一个查询。
 * 2. 发消息用 $transaction：插入消息 + 更新会话 updatedAt 必须同时成功，
 *    否则会出现"消息存在但会话列表不冒泡"的诡异现象。
 * 3. 消息按 createdAt 升序返回（聊天记录从旧到新），会话列表按 updatedAt 降序。
 * 4. 分页统一走第 1 周写好的 paginate()，返回结构与其他接口一致。
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateConversationDto, ListMessagesQueryDto, SendMessageDto } from './dto/conversation.dto';

/**
 * 组装分页结果。
 * 注意：common/utils/pagination.ts 的 paginate() 是给"内存数组"用的（total 取自数组长度）；
 * 这里是数据库分页，total 来自单独的 count 查询，所以要单独拼装。
 */
function pageResult<T>(items: T[], page: number, pageSize: number, total: number) {
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

/** 会话列表项的返回结构（不返回完整消息，只带条数）。 */
export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建会话：标题可选，默认"新对话"。 */
  async create(userId: string, dto: CreateConversationDto): Promise<ConversationSummary> {
    const row = await this.prisma.conversation.create({
      data: { userId, title: dto.title ?? '新对话' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });

    return this.toSummary(row);
  }

  /** 我的会话列表：按最后更新时间倒序（最近聊过的在最上面）。 */
  async listMine(userId: string, page: number, pageSize: number) {
    // 两条查询放同一事务，保证 total 与 items 来自同一快照（Day 2 讲过的分页一致性）。
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.conversation.count({ where: { userId } }),
      this.prisma.conversation.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
      }),
    ]);

    return pageResult(rows.map((row) => this.toSummary(row)), page, pageSize, total);
  }

  /**
   * 会话详情：id + userId 双条件查询。
   * 别人的会话与不存在的会话返回**同一个 404**——不给攻击者"这个 id 存在"的信息。
   */
  async getOwned(userId: string, conversationId: string): Promise<ConversationSummary> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });

    if (!row) {
      throw new NotFoundException('会话不存在');
    }

    return this.toSummary(row);
  }

  /** 拉取某会话的消息（升序，配合分页）。 */
  async listMessages(userId: string, conversationId: string, query: ListMessagesQueryDto) {
    // 先做归属校验：不存在 / 不属于你都直接 404，绝不继续查消息。
    await this.getOwned(userId, conversationId);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.message.count({ where: { conversationId } }),
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { id: true, role: true, content: true, tokens: true, createdAt: true },
      }),
    ]);

    return pageResult(
      rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      query.page,
      query.pageSize,
      total,
    );
  }

  /** 发送消息：插入消息 + 更新会话 updatedAt，必须同一事务。 */
  async addMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    await this.getOwned(userId, conversationId);

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.USER, // 服务端固定，绝不接受客户端传入
          content: dto.content,
        },
        select: { id: true, role: true, content: true, tokens: true, createdAt: true },
      }),
      // 触达 updatedAt，让会话在列表里冒泡到顶部。
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);

    return { ...message, createdAt: message.createdAt.toISOString() };
  }

  private toSummary(row: {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    _count: { messages: number };
  }): ConversationSummary {
    return {
      id: row.id,
      title: row.title,
      messageCount: row._count.messages,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
