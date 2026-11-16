/**
 * 文件作用：认证控制器，暴露注册 / 登录 / 刷新 / 登出 / 当前用户接口。
 *
 * 路由前缀在 @Controller('auth') 上，全局前缀 'api' 在 main.ts 设置，
 * 所以真实路径是 /api/auth/...
 */

import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService, AuthUser, TokenPair } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginThrottleGuard } from './guards/login-throttle.guard';
import { JwtPayload } from './types/jwt-payload';

interface AuthResult {
  user: AuthUser;
  tokens: TokenPair;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /api/auth/register —— 注册成功直接返回令牌对，省掉一次登录请求。
  @Post('register')
  @ApiOperation({ summary: '注册并返回令牌对' })
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.authService.register(dto);
  }

  // POST /api/auth/login
  // @HttpCode(200)：Nest 对 POST 默认 201，登录不是"创建资源"。
  // LoginThrottleGuard：同一 IP + 邮箱连续失败达到上限时返回 429。
  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottleGuard)
  @ApiOperation({ summary: '登录并返回令牌对（失败 5 次锁定 15 分钟）' })
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthResult> {
    // loginKey 由守卫写入，Service 用它累计失败次数，避免两边算法不一致。
    return this.authService.login(dto, request.loginKey);
  }

  // POST /api/auth/refresh —— 用 refresh token 换新的令牌对（旧 refresh 立即作废）。
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: '刷新令牌（轮换：旧 refreshToken 立即失效）' })
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.authService.refresh(dto.refreshToken);
  }

  // POST /api/auth/logout —— 清空 refresh 哈希，刷新能力立即失效。
  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '登出（使 refreshToken 失效）' })
  async logout(@CurrentUser() user: JwtPayload): Promise<void> {
    await this.authService.logout(user.sub);
  }

  // GET /api/auth/me —— 需要 Bearer Token。
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前登录用户（需 Bearer Token）' })
  me(@CurrentUser() user: JwtPayload): Promise<AuthUser> {
    // 只把 sub 传给 Service，其余信息以数据库为准（Token 里的 role 可能是旧的）。
    return this.authService.findMe(user.sub);
  }
}
