/**
 * 文件作用：按用户汇总模型用量（Week 3 Day 6）。
 *
 * 只读 usage_logs，不读消息原文：
 * 1. today 用服务器本地时区的 0 点作为起点。跨时区部署时这个边界会偏移，
 *    MVP 阶段接受该简化，后续可改为按用户时区或 UTC 统计。
 * 2. recent 只返回元数据，前端不需要、也不应该拿到消息内容。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface UsageSummary {
  today: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  recent: Array<{
    id: string;
    model: string;
    template: string;
    totalTokens: number;
    latencyMs: number;
    createdAt: string;
  }>;
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<UsageSummary> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [aggregate, recent] = await this.prisma.$transaction([
      this.prisma.usageLog.aggregate({
        where: { userId, createdAt: { gte: startOfToday } },
        _count: { _all: true },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      }),
      this.prisma.usageLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          model: true,
          template: true,
          totalTokens: true,
          latencyMs: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      today: {
        requests: aggregate._count._all,
        promptTokens: aggregate._sum.promptTokens ?? 0,
        completionTokens: aggregate._sum.completionTokens ?? 0,
        totalTokens: aggregate._sum.totalTokens ?? 0,
      },
      recent: recent.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  }
}
