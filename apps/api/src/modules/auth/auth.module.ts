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
import { RolesGuard } from './guards/roles.guard';

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
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  // 导出两个守卫与 JwtModule：
  // - 其他模块在 @UseGuards(JwtAuthGuard) 时，Nest 会在**使用方模块**的上下文里实例化守卫，
  //   如果没导入 JwtModule 就会报 "Nest can't resolve dependencies of the JwtAuthGuard"。
  // - 导出 JwtModule 等于把 JwtService 一并提供给导入方。
  exports: [JwtModule, AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
