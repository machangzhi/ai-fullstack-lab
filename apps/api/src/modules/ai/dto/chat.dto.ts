import { PROMPT_TEMPLATE_IDS, type PromptTemplateId } from '@ai-lab/ai-core';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Day 2 只接收当前用户消息，role 与 system 提示词由服务端控制。
 * Day 3 增加 template：客户端只能选择已登记的模板 ID，不能提交提示词原文。
 * Week 4 Day 1 增加 model：客户端只能提交公开档案 ID，真实模型名与地址由服务端决定。
 */
export class ChatRequestDto {
  @ApiPropertyOptional({
    example: 'support',
    enum: PROMPT_TEMPLATE_IDS,
    description: 'Prompt 模板 ID；不传时使用 assistant（通用助手）',
  })
  @IsOptional()
  @IsIn([...PROMPT_TEMPLATE_IDS], {
    message: `template 必须是 ${PROMPT_TEMPLATE_IDS.join('、')} 之一`,
  })
  template?: PromptTemplateId;

  @ApiPropertyOptional({
    example: 'deepseek-chat',
    description: '模型档案 ID（来自 GET /api/ai/models）；不传时使用默认档案',
  })
  @IsOptional()
  @IsString({ message: 'model 必须是字符串' })
  @Length(1, 32, { message: 'model 长度需在 1-32 个字符之间' })
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'model 只能包含小写字母、数字和连字符',
  })
  model?: string;

  @ApiPropertyOptional({
    example: '我买的课一直白屏打不开，能退款吗？',
    description: '发送给模型的用户输入',
  })
  @IsString({ message: 'message 必须是字符串' })
  @Length(1, 8000, { message: 'message 长度需在 1-8000 个字符之间' })
  @Matches(/\S/, { message: 'message 不能只包含空白字符' })
  message!: string;
}
