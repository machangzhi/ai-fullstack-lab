import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/** 分类与实体抽取共用：只接收一段待处理文本，结构由服务端 schema 决定。 */
export class StructuredTextDto {
  @ApiProperty({
    example: '申请退款三天了还没到账，客服也不回复。',
    description: '待分类或抽取实体的原文',
  })
  @IsString({ message: 'text 必须是字符串' })
  @Length(1, 8000, { message: 'text 长度需在 1-8000 个字符之间' })
  @Matches(/\S/, { message: 'text 不能只包含空白字符' })
  text!: string;
}
