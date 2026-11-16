/**
 * 文件作用：登录请求体 DTO。
 *
 * 与注册 DTO 的区别：登录只做"非空"校验，不校验密码强度。
 * 原因：强度规则是注册时的约束，登录时如果也校验，
 * 老用户的弱密码会直接登录失败，而且会泄露"我们的密码规则"。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail({}, { message: '请输入合法的邮箱地址' })
  email!: string;

  @ApiProperty({ example: 'P@ssw0rd123' })
  @IsString()
  @MinLength(1, { message: '请输入密码' })
  password!: string;
}
