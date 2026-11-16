/**
 * 文件作用：认证模块，装配 JwtModule 与认证相关组件。
 *
 * 关键概念：
 * 1. JwtModule.registerAsync：密钥来自 ConfigService，而不是硬编码。
 *    useFactory 里做"缺失即抛错"，保证服务不会带着空密钥启动——
 *    空密钥签发的 Token 等于人人可伪造。
 * 2. expiresIn 用配置项，开发期可以调长，生产期调短。
 * 3. JwtAuthGuard 注册为 provider 后，Controller 里 @UseGuards(JwtAuthGuard) 才能解析到
 *    它的构造依赖（JwtService）。
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');

        if (!secret || secret.length < 16) {
          // 快速失败：宁可启动不了，也不要线上出现可伪造的 Token。
          throw new Error('JWT_SECRET 未配置或长度不足 16 位，请检查 .env');
        }

        return {
          secret,
          signOptions: {
            // jsonwebtoken v9 对 expiresIn 使用模板字面量类型（如 "7d"），
            // 从配置读出来是普通 string，这里做一次收窄。
            expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') as unknown as number,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  // 导出 JwtAuthGuard，后续（如 users 模块的受保护接口）可以复用同一个守卫实例。
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
