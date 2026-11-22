/**
 * 文件作用：知识库检索请求 DTO（Week 5 Day 6）。
 *
 * 限制范围的原因：
 * - query 太短没有检索价值，太长会浪费 Embedding 费用；
 * - topK 过大不仅慢，还会把无关片段塞进后续上下文；
 * - minSimilarity 必须在 0~1，避免「距离」和「相似度」混用。
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class SearchKnowledgeDto {
  @ApiProperty({
    example: '一线城市住宿标准是多少？',
    description: '检索问题，1~500 个字符',
  })
  @IsString({ message: 'query 必须是字符串' })
  @Length(1, 500, { message: 'query 长度需在 1-500 个字符之间' })
  @Matches(/\S/, { message: 'query 不能只包含空白字符' })
  query!: string;

  @ApiPropertyOptional({ example: 5, description: '返回条数，1~20，默认 5' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'topK 必须是整数' })
  @Min(1, { message: 'topK 最小为 1' })
  @Max(20, { message: 'topK 最大为 20' })
  topK?: number;

  @ApiPropertyOptional({ description: '只检索指定文档' })
  @IsOptional()
  @IsString({ message: 'documentId 必须是字符串' })
  @Length(1, 64, { message: 'documentId 长度需在 1-64 个字符之间' })
  @Matches(/\S/, { message: 'documentId 不能只包含空白字符' })
  documentId?: string;

  @ApiPropertyOptional({
    example: 0.5,
    description: '最低余弦相似度，0~1；不传表示不过滤',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'minSimilarity 必须是数值' },
  )
  @Min(0, { message: 'minSimilarity 最小为 0' })
  @Max(1, { message: 'minSimilarity 最大为 1' })
  minSimilarity?: number;
}
