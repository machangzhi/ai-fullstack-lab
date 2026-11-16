/**
 * 文件作用：PrismaService —— 把 PrismaClient 接入 NestJS 依赖注入体系。
 *
 * 关键概念：
 * 1. PrismaClient 内部持有一个数据库连接池。整个应用应该只用一个实例，
 *    所以这里用 @Injectable() 的默认单例作用域，禁止在业务代码里 new PrismaClient()。
 * 2. onModuleInit / onModuleDestroy 是 NestJS 的生命周期钩子：
 *    - 应用启动时建立连接（$connect），让「连不上数据库」在启动阶段就暴露，而不是等第一个请求；
 *    - 应用关闭时断开（$disconnect），避免进程退出后连接泄漏。
 * 3. 继承 PrismaClient 后，所有模型访问器（this.user / this.conversation / this.message）
 *    都可直接用，且带完整类型提示。
 * 4. 真正的连接串来自 schema.prisma 的 env("DATABASE_URL")，
 *    由 Prisma CLI 在生成 Client 时读取，业务代码不关心。
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  // 应用启动时调用：提前建立连接，失败会直接让启动报错（快速失败原则）。
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('数据库连接已建立');
  }

  // 应用关闭时调用：释放连接池，避免开发时热重载积累僵尸连接。
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('数据库连接已关闭');
  }
}
