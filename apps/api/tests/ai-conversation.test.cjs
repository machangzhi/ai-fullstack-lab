/**
 * 文件作用：多轮会话服务测试（Week 3 Day 6）。
 *
 * 不连接数据库：ConversationsService、AiService、PrismaService 都用最小假实现，
 * 只验证编排逻辑——历史映射、消息落库顺序、用量日志和中断行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const {
  ConversationChatService,
} = require('../dist/modules/conversations/conversation-chat.service.js');
const { AppError } = require('../dist/common/errors/app-error.js');

function createPrismaFake(overrides = {}) {
  const calls = {
    messages: [],
    conversationUpdates: [],
    usageLogs: [],
  };

  const prisma = {
    message: {
      findMany: async () => [
        { role: 'ASSISTANT', content: '旧的回答' },
        { role: 'USER', content: '旧的问题' },
      ],
      create: async ({ data }) => {
        calls.messages.push(data);
        return { id: 'assistant-message' };
      },
    },
    conversation: {
      update: async ({ data }) => {
        calls.conversationUpdates.push(data);
        return { id: 'conversation-1' };
      },
    },
    usageLog: {
      create: async ({ data }) => {
        calls.usageLogs.push(data);
        return { id: 'usage-1' };
      },
    },
    $transaction: async (operations) => Promise.all(operations),
    ...overrides,
  };

  return { prisma, calls };
}

function createConversationsFake(title = '新对话') {
  const added = [];
  return {
    added,
    getOwned: async () => ({
      id: 'conversation-1',
      title,
      messageCount: 2,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    }),
    addMessage: async (_userId, _conversationId, dto) => {
      added.push(dto.content);
      return { id: 'user-message', role: 'USER', content: dto.content, tokens: 0 };
    },
  };
}

function createAiFake(events) {
  const received = [];
  return {
    received,
    streamWithHistory: async function* (history, message, templateId) {
      received.push({ history, message, templateId });
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

test('成功路径：回放历史、先存用户消息、再存回复与用量', async () => {
  // Arrange
  const { prisma, calls } = createPrismaFake();
  const conversations = createConversationsFake();
  const ai = createAiFake([
    { type: 'delta', content: '第一段' },
    { type: 'delta', content: '第二段' },
    {
      type: 'meta',
      model: 'deepseek-chat',
      template: 'assistant',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    },
  ]);
  const service = new ConversationChatService(prisma, conversations, ai);

  // Act
  const events = await collect(
    service.streamReply('user-1', 'conversation-1', '这是本次的问题', 'assistant'),
  );

  // Assert：历史按时间从旧到新映射，且只包含 user/assistant
  assert.deepEqual(ai.received[0].history, [
    { role: 'user', content: '旧的问题' },
    { role: 'assistant', content: '旧的回答' },
  ]);
  assert.deepEqual(conversations.added, ['这是本次的问题']);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].role, 'ASSISTANT');
  assert.equal(calls.messages[0].content, '第一段第二段');
  assert.equal(calls.messages[0].tokens, 14);
  assert.equal(calls.conversationUpdates[0].title, '这是本次的问题');
  assert.deepEqual(calls.usageLogs[0], {
    userId: 'user-1',
    conversationId: 'conversation-1',
    model: 'deepseek-chat',
    template: 'assistant',
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    latencyMs: calls.usageLogs[0].latencyMs,
  });
  assert.equal(events.at(-1).type, 'meta');
  assert.equal(events.at(-1).conversationId, 'conversation-1');
});

test('已有自定义标题时不被首条消息覆盖', async () => {
  // Arrange
  const { prisma, calls } = createPrismaFake();
  const conversations = createConversationsFake('我的固定标题');
  const ai = createAiFake([
    { type: 'delta', content: '回答' },
    { type: 'meta', model: 'deepseek-chat', usage: null },
  ]);
  const service = new ConversationChatService(prisma, conversations, ai);

  // Act
  await collect(service.streamReply('user-1', 'conversation-1', '新问题', 'assistant'));

  // Assert
  assert.equal(calls.conversationUpdates[0].title, '我的固定标题');
});

test('客户端中断：不保存助手回复，也不写用量日志', async () => {
  // Arrange
  const { prisma, calls } = createPrismaFake();
  const conversations = createConversationsFake();
  const controller = new AbortController();
  const ai = {
    streamWithHistory: async function* () {
      yield { type: 'delta', content: '半截' };
      controller.abort();
      return;
    },
  };
  const service = new ConversationChatService(prisma, conversations, ai);

  // Act
  const events = await collect(
    service.streamReply(
      'user-1',
      'conversation-1',
      '这个问题会中断',
      'assistant',
      controller.signal,
    ),
  );

  // Assert
  assert.deepEqual(events, [{ type: 'delta', content: '半截' }]);
  assert.deepEqual(conversations.added, ['这个问题会中断']);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.usageLogs.length, 0);
});

test('保存回复失败时返回 CHAT_PERSIST_FAILED', async () => {
  // Arrange
  const { prisma } = createPrismaFake();
  prisma.message.create = async () => {
    throw new Error('database unavailable');
  };
  const conversations = createConversationsFake();
  const ai = createAiFake([
    { type: 'delta', content: '回答' },
    { type: 'meta', model: 'deepseek-chat', usage: null },
  ]);
  const service = new ConversationChatService(prisma, conversations, ai);

  // Act & Assert
  await assert.rejects(
    collect(service.streamReply('user-1', 'conversation-1', '问题', 'assistant')),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'CHAT_PERSIST_FAILED');
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test('用量日志写入失败不影响回复保存与 meta 返回', async () => {
  // Arrange
  const { prisma, calls } = createPrismaFake();
  prisma.usageLog.create = async () => {
    throw new Error('usage log failure');
  };
  const conversations = createConversationsFake();
  const ai = createAiFake([
    { type: 'delta', content: '回答' },
    {
      type: 'meta',
      model: 'deepseek-chat',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    },
  ]);
  const service = new ConversationChatService(prisma, conversations, ai);

  // Act
  const events = await collect(
    service.streamReply('user-1', 'conversation-1', '问题', 'assistant'),
  );

  // Assert
  assert.equal(calls.messages.length, 1);
  assert.equal(events.at(-1).type, 'meta');
});
