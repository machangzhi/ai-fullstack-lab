/**
 * 文件作用：创建用户 DTO（Data Transfer Object）。
 *
 * 关键概念：
 * 1. DTO 是什么？—— 数据传输对象，定义接口接收/返回的数据结构。
 *    它和 Entity 的区别：Entity 是数据库表结构，DTO 是接口入参/出参结构，两者可能不同
 *    （比如 DTO 不含密码字段，但 Entity 有）。
 * 2. class-validator 装饰器 —— 配合 main.ts 的 ValidationPipe 自动校验入参：
 *    - @IsEmail()：必须是合法邮箱。
 *    - @IsString() + @Length(2, 50)：字符串，长度 2-50。
 *    - @IsOptional()：可选字段，不传不校验。
 *    - @IsIn(['admin', 'member'])：只能是这两个值之一。
 * 3. class-validator 校验失败时，ValidationPipe 抛 BadRequestException，
 *    被 AllExceptionsFilter 捕获后返回 400 + 字段级错误明细。
 * 4. @ApiProperty / @ApiPropertyOptional —— Swagger 注解，生成文档时显示字段说明和示例。
 * 5. `!:` 语法（确定赋值断言）—— 告诉 TS "这个字段一定会被赋值"（由 ValidationPipe 或调用方保证），
 *    避免 strict 模式下报"属性未初始化"错误。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateUserDto {
  // 邮箱：必填，必须是合法邮箱格式。
  @ApiProperty({ example: 'demo@example.com' })
  @IsEmail()
  email!: string;

  // 姓名：必填，字符串，长度 2-50。
  @ApiProperty({ example: '示例用户', minLength: 2, maxLength: 50 })
  @IsString()
  @Length(2, 50)
  name!: string;

  // 角色：可选，只能是 admin 或 member，默认 member（在 Service 里给默认值）。
  @ApiPropertyOptional({ enum: ['admin', 'member'], default: 'member' })
  @IsOptional()
  @IsIn(['admin', 'member'])
  role?: 'admin' | 'member';
}
