/**
 * 文件作用：刷新令牌请求体。
 *
 * 说明：refresh token 也可以放 HttpOnly Cookie（更安全，防 XSS 读取），
 * 本项目为便于调试放在请求体里。生产环境推荐 Cookie + SameSite。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: '登录或注册时返回的 refreshToken' })
  @IsString()
  @MinLength(1, { message: 'refreshToken 不能为空' })
  refreshToken!: string;
}
