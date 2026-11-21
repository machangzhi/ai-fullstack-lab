/**
 * 文件作用：会话摘要记忆测试（Week 4 Day 2）。
 *
 * 不连接数据库、不调用真实模型：用最小假实现验证
 * 上下文规划 → 阈值判断 → 增量摘要 → 游标推进 → 降级路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const {
  ConversationChatService,
} = require('../dist/modules/conversations/conversation-chat.service.js');

function createHistory(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
    content: `消息 ${index + 1}`,
  }));
}

function createPrismaFake(history, memory = { historySummary: null, summarizedMessages: 0 }) {
  const calls = {
    messages: [],
    updates: [],
    usageLogs: [],
  };

  const prisma = {
    message: {
      findMany: async () => history,
      create: async ({ data }) => {
        calls.messages.push(data);
        return { id: 'assistant-message' };
      },
    },
    conversation: {
      findFirst: async () => memory,
      update: async ({ data }) => {
        calls.updates.push(data);
        return { id: 'conversation-1' };
      },
    },
    usageLog: {
      create: async ({ data }) => {
        calls.usageLogs.push(data);
        return { id: `usage-${calls.usageLogs.length}` };
      },
    },
    $transaction: async (operations) => Promise.all(operations),
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
      messageCount: 0,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    }),
    addMessage: async (_userId, _conversationId, dto) => {
      added.push(dto.content);
      return { id: 'user-message', role: 'USER', content: dto.content, tokens: 0 };
    },
  };
}

function createAiFake(options = {}) {
  const calls = { summarize: [], stream: [] };
  const {
    contextWindow = 65536,
    maxOutputTokens = 2048,
    summary = '新摘要',
    summaryError = null,
  } = options;

  return {
    calls,
    getModelLimits: () => ({ contextWindow, maxOutputTokens }),
    summarizeHistory: async (previousSummary, overflow, profileId) => {
      calls.summarize.push({ previousSummary, overflow, profileId });
      if (summaryError) {
        throw summaryError;
      }
      return {
        summary,
        model: 'deepseek-chat',
        modelId: 'deepseek-chat',
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      };
    },
    streamWithHistory: async function* (history, message, templateId, streamOptions) {
      calls.stream.push({ history, message, templateId, options: streamOptions });
      yield { type: 'delta', content: '回答' };
      yield {
        type: 'meta',
        modelId: 'deepseek-chat',
        model: 'deepseek-chat',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      };
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

test('溢出达到阈值时增量摘要、推进游标，并把摘要传给下一轮上下文', async () => {
  // Arrange
  const { prisma, calls } = createPrismaFake(createHistory(26));
  const ai = createAiFake({ summary: '用户在学习上下文管理。' });
  const service = new ConversationChatService(prisma, createConversationsFake(), ai);

  // Act
  const events = await collect(
    service.streamReply(
      'user-1',
      'conversation-1',
      '本次问题',
      'assistant',
      undefined,
      'deepseek-chat',
    ),
  );

  // Assert
  assert.equal(ai.calls.summarize.length, 1);
  assert.equal(ai.calls.summarize[0].overflow.length, 6);
  assert.equal(ai.calls.summarize[0].overflow[0].content, '消息 1');
  assert.equal(ai.calls.summarize[0].profileId, 'deepseek-chat');

  const memoryUpdate = calls.updates.find((item) => item.historySummary !== undefined);
  assert.ok(memoryUpdate);
  assert.equal(memoryUpdate.historySummary, '用户在学习上下文管理。');
  assert.deepEqual(memoryUpdate.summarizedMessages, { increment: 6 });

  assert.equal(ai.calls.stream[0].history.length, 20);
  assert.equal(ai.calls.stream[0].options.memorySummary, '用户在学习上下文管理。');
  assert.equal(events.at(-1).type, 'meta');

  const summaryLog = calls.usageLogs.find((item) => item.template === 'memory-summary');
  assert.ok(summaryLog);
  assert.equal(summaryLog.totalTokens, 70);
});

test('摘要失败时降级为原文裁剪：不推进游标、不阻断回复', async () => {
  // Arrange
  const { prisma, calls } = createPrismaFake(createHistory(26));
  const ai = createAiFake({ summaryError: new Error('summary model unavailable') });
  const service = new ConversationChatService(prisma, createConversationsFake(), ai);

  // Act
  const events = await collect(
    service.streamReply('user-1', 'conversation-1', '本次问题', 'assistant'),
  );

  // Assert
  assert.equal(ai.calls.summarize.length, 1);
  assert.equal(
    calls.updates.some((item) => item.historySummary !== undefined),
    false,
  );
  assert.equal(ai.calls.stream[0].options.memorySummary, null);
  assert.equal(calls.messages.length, 1);
  assert.equal(events.at(-1).type, 'meta');
});

test('已有摘要且本轮溢出很少时不重复调用摘要，但仍回放旧摘要', async () => {
  // Arrange
  const memory = { historySummary: '旧摘要：用户在学 Prisma', summarizedMessages: 4 };
  const { prisma } = createPrismaFake(createHistory(22), memory);
  const ai = createAiFake();
  const service = new ConversationChatService(prisma, createConversationsFake(), ai);

  // Act
  await collect(service.streamReply('user-1', 'conversation-1', '继续讲', 'assistant'));

  // Assert
  assert.equal(ai.calls.summarize.length, 0);
  assert.equal(ai.calls.stream[0].history.length, 20);
  assert.equal(ai.calls.stream[0].options.memorySummary, '旧摘要：用户在学 Prisma');
});

test('上下文窗口很小时，即使条数不多也会触发摘要', async () => {
  // Arrange
  const history = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
    content: `${'内容'.repeat(100)}${index}`,
  }));
  const { prisma } = createPrismaFake(history);
  const ai = createAiFake({ contextWindow: 1500, maxOutputTokens: 300 });
  const service = new ConversationChatService(prisma, createConversationsFake(), ai);

  // Act
  await collect(service.streamReply('user-1', 'conversation-1', '本次问题', 'assistant'));

  // Assert
  assert.equal(ai.calls.summarize.length, 1);
  assert.ok(ai.calls.summarize[0].overflow.length >= 4);
  assert.ok(ai.calls.stream[0].history.length < history.length);
});
