import { PickType } from '@nestjs/swagger';
import { ChatRequestDto } from './chat.dto';

/**
 * 工具调用入口只接收消息与可选模型档案。
 * template 不适用：system 提示词由服务端固定，客户端无法替换工具规则。
 */
export class ToolChatRequestDto extends PickType(ChatRequestDto, ['model', 'message'] as const) {}
