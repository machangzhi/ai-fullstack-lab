/**
 * 文件作用：应用根模块（AppModule）。
 *
 * 关键概念：
 * 1. NestJS 模块系统：每个 @Module 是一个功能单元，声明它的控制器（controllers）、
 *    服务提供者（providers）、导入的其他模块（imports）、导出的内容（exports）。
 * 2. AppModule 是根模块，NestFactory.create(AppModule) 会从这里开始递归加载所有子模块。
 * 3. ConfigModule.forRoot —— 加载 .env 文件并全局注册 ConfigService，isGlobal:true 表示
 *    其他模块不用再 imports 就能注入 ConfigService。
 * 4. envFilePath 顺序：['.env.local', '.env']，前者优先级更高（本地开发覆盖默认配置）。
 * 5. cache:true —— 缓存环境变量读取结果，避免每次 get 都解析文件。
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.module';
import { SystemModule } from './modules/system/system.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // 配置模块：全局可用，加载 .env.local 与 .env。
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // 数据库模块：全局注册 PrismaService，业务模块无需重复 imports。
    PrismaModule,
    // 健康检查模块：GET /api/health。
    HealthModule,
    // 认证模块：POST /api/auth/register|login、GET /api/auth/me。
    AuthModule,
    // AI 模块：POST /api/ai/chat（DeepSeek 单轮非流式问答）。
    AiModule,
    // 用户模块：GET/POST /api/users（第 2 周起由 Prisma 落库）。
    UsersModule,
    // 会话与消息：/api/conversations 及其下的 messages 子资源。
    ConversationsModule,
    // 文件上传：POST /api/files/upload。
    FilesModule,
    // 系统模块：GET /api/config（公开运行配置，不含密钥）。
    SystemModule,
  ],
})
export class AppModule {}
