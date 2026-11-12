/**
 * 文件作用：用户列表查询 DTO（query 参数）。
 *
 * 关键概念：
 * 1. Query 参数在 URL 里都是字符串（如 ?page=2&pageSize=20&keyword=abc），
 *    但我们希望 page/pageSize 是数字。两种做法：
 *    a. transformOptions.enableImplicitConversion: true（全局自动转）
 *    b. 在字段上加 @Type(() => Number)（显式声明转换）
 *    本项目选 b，更明确，避免隐式转换带来的意外。
 * 2. @Type(() => Number) 来自 class-transformer，告诉转换器把字符串转成数字。
 * 3. @Min(1) / @Max(100) —— 数值范围校验，防止 pageSize 传 1000 把库查爆。
 *    （pagination.ts 里也会再兜底一次，双重保险。）
 * 4. keyword —— 按邮箱或姓名模糊搜索，可选字符串。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListUsersQueryDto {
  // 页码：可选，整数，最小 1。
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number) // 把 query 字符串 '2' 转成数字 2
  @IsInt()
  @Min(1)
  page?: number;

  // 每页条数：可选，整数，1-100。
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  // 搜索关键词：可选，按邮箱或姓名模糊匹配。
  @ApiPropertyOptional({ description: '按邮箱或姓名模糊搜索' })
  @IsOptional()
  @IsString()
  keyword?: string;
}
