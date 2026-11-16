/**
 * 文件作用：认证控制器，暴露注册 / 登录 / 当前用户三个接口。
 *
 * 路由前缀在 @Controller('auth') 上，而全局前缀 'api' 在 main.ts 里设置，
 * 所以真实路径是 /api/auth/...
 *
 * Controller 保持"薄"：只做参数接收与转发，业务全在 AuthService。
 */

import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService, AuthUser } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtPayload } from './types/jwt-payload';

interface AuthResult {
  user: AuthUser;
  accessToken: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /api/auth/register —— 注册成功直接返回 Token，省掉一次登录请求。
  @Post('register')
  @ApiOperation({ summary: '注册并返回访问令牌' })
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.authService.register(dto);
  }

  // POST /api/auth/login
  // @HttpCode(200)：Nest 对 POST 默认返回 201，登录并不是"创建资源"，应为 200。
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: '登录并返回访问令牌' })
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.authService.login(dto);
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
