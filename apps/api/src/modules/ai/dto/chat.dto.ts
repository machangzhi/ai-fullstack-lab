import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/** Day 2 只接收当前用户消息，role 与 system 提示词由服务端控制。 */
export class ChatRequestDto {
  @ApiProperty({ example: '什么是上下文窗口？', description: '发送给模型的用户问题' })
  @IsString({ message: 'message 必须是字符串' })
  @Length(1, 8000, { message: 'message 长度需在 1-8000 个字符之间' })
  @Matches(/\S/, { message: 'message 不能只包含空白字符' })
  message!: string;
}
