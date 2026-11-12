/**
 * 文件作用：聊天消息相关类型定义（第 3-4 周 AI Chat 会用到）。
 *
 * 关键概念：
 * 1. ChatRole —— 消息角色，对齐 OpenAI/通用大模型对话协议：
 *    - system：系统提示词，设定 AI 行为边界
 *    - user：用户输入
 *    - assistant：AI 回复
 *    - tool：工具调用结果（Agent 场景）
 * 2. ChatMessage —— 一条消息的完整结构，包含所属会话 conversationId、角色、内容、创建时间。
 * 3. 第 1 周先把类型定义好，第 3 周接模型时直接复用，避免到时候再改数据结构。
 */

// 消息角色：对齐大模型对话协议的标准角色。
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

// 聊天消息实体：第 3 周会存入数据库（conversations/messages 表）。
export interface ChatMessage {
  id: string; // 消息唯一 ID
  conversationId: string; // 所属会话 ID
  role: ChatRole; // 消息角色
  content: string; // 消息内容
  createdAt: string; // 创建时间（ISO 字符串）
}
