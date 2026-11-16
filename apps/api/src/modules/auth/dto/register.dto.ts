/**
 * 文件作用：注册请求体 DTO。
 *
 * 校验规则就是"注册密码强度"的第一道门：
 * - MinLength(8)：长度是最基本的强度要求（NIST 建议最少 8 位）
 * - MaxLength(64)：防止超长输入造成的哈希 CPU 消耗攻击
 * - Matches：至少包含字母和数字，避免 12345678 这类纯数字
 *
 * 注意：这里没有 "确认密码" 字段。确认密码是前端交互，不该进 API 契约。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'alice@example.com', description: '登录邮箱，全局唯一' })
  @IsEmail({}, { message: '请输入合法的邮箱地址' })
  email!: string;

  @ApiProperty({ example: 'Alice', description: '显示名称' })
  @IsString()
  @Length(2, 32, { message: '昵称长度需在 2-32 个字符之间' })
  name!: string;

  @ApiProperty({ example: 'P@ssw0rd123', description: '密码，至少 8 位且含字母和数字' })
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(64, { message: '密码最多 64 位' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: '密码必须同时包含字母和数字' })
  password!: string;
}
