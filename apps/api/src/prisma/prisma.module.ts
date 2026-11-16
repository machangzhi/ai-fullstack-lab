/**
 * 文件作用：PrismaModule —— 全局数据库模块。
 *
 * 关键概念：
 * 1. @Global() 让这个模块的 exports 在整个应用中可见，
 *    业务模块（UsersModule、ConversationModule...）不需要逐个 imports，
 *    直接 constructor(private readonly prisma: PrismaService) 即可。
 * 2. 为什么敢用全局模块：数据库连接是「基础设施」，每个业务模块都要，
 *    逐个 import 只会制造噪音。这与 ConfigModule.forRoot({ isGlobal: true }) 同理。
 * 3. 只有 PrismaService 是 provider，并且必须 exports，否则别的模块注入不到。
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
