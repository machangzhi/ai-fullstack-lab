/**
 * 文件作用：会话与消息相关的三个 DTO。
 *
 * 为什么放在一个文件：
 * 它们高度相关、都很短，拆成三个文件反而增加跳转成本（对比 users 模块的 DTO 较多且独立）。
 *
 * 关键概念：
 * 1. 客户端**不能**指定消息的 role。允许客户端传 role 就等于允许伪造 assistant 消息，
 *    会污染上下文、也能用于 prompt 注入。服务端固定为 USER。
 * 2. 内容长度上限既是产品约束，也是防御：避免超长文本撑爆数据库与后续的模型调用费用。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateConversationDto {
  @ApiPropertyOptional({ example: '关于 Prisma 的问题', description: '会话标题，省略则用默认值' })
  @IsOptional()
  @IsString()
  @Length(1, 80, { message: '标题长度需在 1-80 个字符之间' })
  title?: string;
}

export class SendMessageDto {
  @ApiProperty({ example: '帮我解释一下什么是事务', description: '消息内容（纯文本）' })
  @IsString()
  @Length(1, 8000, { message: '消息长度需在 1-8000 个字符之间' })
  content!: string;
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  // @Type：query 里全是字符串，先转数字，@IsInt 才能通过（Day 4 讲过的"先转换再校验"）
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100, { message: 'pageSize 最大 100' })
  pageSize: number = 50;
}
