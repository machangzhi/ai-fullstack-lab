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
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SEARCHABLE_DOCUMENT_FORMATS } from '../vector-store.types';

/**
 * 检索过滤条件（Week 6 Day 1）。
 *
 * 这些条件互斥地缩小范围：文档 ID、格式、文件名、标题、章节路径、metadata。
 * 数组都限制长度，避免一次请求生成过长的 SQL 参数列表。
 */
export class KnowledgeSearchFiltersDto {
  @ApiPropertyOptional({
    description: '只检索这些文档 ID，最多 20 个',
    example: ['cm8abc123'],
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'filters.documentIds 必须是数组' })
  @ArrayMinSize(1, { message: 'filters.documentIds 至少 1 个' })
  @ArrayMaxSize(20, { message: 'filters.documentIds 最多 20 个' })
  @IsString({ each: true, message: 'filters.documentIds 的每一项必须是字符串' })
  @Length(1, 64, { each: true, message: 'filters.documentIds 每项长度需在 1-64 之间' })
  @Matches(/\S/, { each: true, message: 'filters.documentIds 每项不能只包含空白字符' })
  documentIds?: string[];

  @ApiPropertyOptional({
    description: '只检索这些格式：pdf / docx / txt / markdown',
    example: ['markdown'],
    enum: SEARCHABLE_DOCUMENT_FORMATS,
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: 'filters.formats 必须是数组' })
  @ArrayMinSize(1, { message: 'filters.formats 至少 1 个' })
  @ArrayMaxSize(4, { message: 'filters.formats 最多 4 个' })
  @IsIn([...SEARCHABLE_DOCUMENT_FORMATS], {
    each: true,
    message: 'filters.formats 只支持 pdf / docx / txt / markdown',
  })
  formats?: string[];

  @ApiPropertyOptional({
    description: '文件名包含该子串（不区分大小写）',
    example: 'travel',
  })
  @IsOptional()
  @IsString({ message: 'filters.filenameContains 必须是字符串' })
  @Length(1, 100, { message: 'filters.filenameContains 长度需在 1-100 之间' })
  @Matches(/\S/, { message: 'filters.filenameContains 不能只包含空白字符' })
  filenameContains?: string;

  @ApiPropertyOptional({
    description: '文档标题包含该子串（不区分大小写）',
    example: '差旅',
  })
  @IsOptional()
  @IsString({ message: 'filters.titleContains 必须是字符串' })
  @Length(1, 100, { message: 'filters.titleContains 长度需在 1-100 之间' })
  @Matches(/\S/, { message: 'filters.titleContains 不能只包含空白字符' })
  titleContains?: string;

  @ApiPropertyOptional({
    description: '章节路径前缀，按顺序逐层匹配',
    example: ['差旅制度', '住宿标准'],
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'filters.sectionPathPrefix 必须是数组' })
  @ArrayMinSize(1, { message: 'filters.sectionPathPrefix 至少 1 个' })
  @ArrayMaxSize(10, { message: 'filters.sectionPathPrefix 最多 10 个' })
  @IsString({ each: true, message: 'filters.sectionPathPrefix 的每一项必须是字符串' })
  @Length(1, 100, { each: true, message: 'filters.sectionPathPrefix 每项长度需在 1-100 之间' })
  @Matches(/\S/, { each: true, message: 'filters.sectionPathPrefix 每项不能只包含空白字符' })
  sectionPathPrefix?: string[];

  @ApiPropertyOptional({
    description: '文档 metadata 的精确匹配，值支持字符串、数值或布尔值',
    example: { source: 'pdf-info' },
    type: Object,
  })
  @IsOptional()
  @IsObject({ message: 'filters.metadata 必须是对象' })
  metadata?: Record<string, string | number | boolean>;
}

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

  @ApiPropertyOptional({
    description: '文档/章节/元数据过滤条件，全部为硬约束',
    type: KnowledgeSearchFiltersDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => KnowledgeSearchFiltersDto)
  filters?: KnowledgeSearchFiltersDto;
}
