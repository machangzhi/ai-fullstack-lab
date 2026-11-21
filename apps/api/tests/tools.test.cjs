/**
 * 文件作用：工具调用测试（Week 4 Day 3）。
 *
 * 覆盖三层：
 * 1. ToolRegistry：工具目录、Zod 参数校验、执行错误隔离；
 * 2. ToolChatService：工具消息往返、结果回填、轮次上限、用量累计；
 * 3. Transport：把内部工具定义映射为 OpenAI tools，并解析 tool_calls。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { resolveModelProfiles } = require('@ai-lab/ai-core');
const { AppError } = require('../dist/common/errors/app-error.js');
const { OpenAiChatTransport } = require('../dist/modules/ai/openai-chat.transport.js');
const { ToolChatService } = require('../dist/modules/ai/tools/tool-chat.service.js');
const { ToolRegistry } = require('../dist/modules/ai/tools/tool-registry.service.js');

const DEEPSEEK_ENV = {
  MODEL_PROVIDER: 'deepseek',
  MODEL_API_KEY: 'test-deepseek-key',
};

function defaultProfile() {
  const registry = resolveModelProfiles(DEEPSEEK_ENV);
  return registry.profiles.find((item) => item.id === registry.defaultProfileId);
}

function usage(total) {
  return { promptTokens: total, completionTokens: total, totalTokens: total };
}

function createAiFake(script) {
  const calls = [];
  return {
    calls,
    async completeWithTools(messages, tools, profileId) {
      // 消息数组随后会被原地追加，这里先快照，便于断言历史往返。
      calls.push({
        messages: JSON.parse(JSON.stringify(messages)),
        tools,
        profileId,
      });
      const next = script.shift();
      if (!next) {
        throw new Error('测试脚本已耗尽');
      }
      return next;
    },
  };
}

function createPrismaFake() {
  const usageLogs = [];
  return {
    usageLogs,
    prisma: {
      usageLog: {
        create: async ({ data }) => {
          usageLogs.push(data);
          return { id: `usage-${usageLogs.length}` };
        },
      },
    },
  };
}

test('注册表暴露两个工具，并按 Zod schema 执行', async () => {
  // Arrange
  const registry = new ToolRegistry();

  // Act
  const definitions = registry.getDefinitions();
  const time = await registry.execute('get_current_time', '{"timezone":"Asia/Shanghai"}');
  const sum = await registry.execute('calculator', '{"operation":"add","left":2,"right":3}');

  // Assert
  assert.deepEqual(
    definitions.map((item) => item.name),
    ['get_current_time', 'calculator'],
  );
  assert.equal(definitions[0].parameters.additionalProperties, false);

  assert.equal(time.ok, true);
  assert.equal(time.output.timezone, 'Asia/Shanghai');
  assert.ok(!Number.isNaN(Date.parse(time.output.iso)));

  assert.equal(sum.ok, true);
  assert.equal(sum.output.result, 5);
});

test('非法参数、未知工具与除零都不会抛出到上层', async () => {
  // Arrange
  const registry = new ToolRegistry();

  // Act
  const invalidJson = await registry.execute('calculator', '{oops');
  const missingField = await registry.execute('calculator', '{"operation":"add","left":2}');
  const extraField = await registry.execute(
    'calculator',
    '{"operation":"add","left":2,"right":3,"secret":true}',
  );
  const divideByZero = await registry.execute(
    'calculator',
    '{"operation":"divide","left":1,"right":0}',
  );
  const unknown = await registry.execute('drop_database', '{}');
  const badTimezone = await registry.execute('get_current_time', '{"timezone":"Mars/Base"}');

  // Assert
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.error, /合法 JSON/);

  assert.equal(missingField.ok, false);
  assert.match(missingField.error, /参数不合法/);

  assert.equal(extraField.ok, false);
  assert.match(extraField.error, /参数不合法/);

  assert.equal(divideByZero.ok, false);
  assert.match(divideByZero.error, /除数不能为 0/);

  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知工具/);

  assert.equal(badTimezone.ok, false);
});

test('工具调用循环：请求 → 执行 → 结果回填 → 最终回答', async () => {
  // Arrange
  const ai = createAiFake([
    {
      content: null,
      toolCalls: [
        {
          id: 'call-1',
          name: 'calculator',
          arguments: '{"operation":"add","left":2,"right":3}',
        },
      ],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(10),
      finishReason: 'tool_calls',
    },
    {
      content: '2 + 3 = 5。',
      toolCalls: [],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(20),
      finishReason: 'stop',
    },
  ]);
  const { prisma, usageLogs } = createPrismaFake();
  const service = new ToolChatService(ai, new ToolRegistry(), prisma);

  // Act
  const result = await service.chat('user-1', '2 加 3 等于多少？', 'deepseek-chat');

  // Assert
  assert.equal(result.reply, '2 + 3 = 5。');
  assert.equal(result.rounds, 2);
  assert.equal(result.modelId, 'deepseek-chat');
  assert.deepEqual(result.usage, usage(30));

  assert.equal(result.toolRuns.length, 1);
  assert.equal(result.toolRuns[0].name, 'calculator');
  assert.equal(result.toolRuns[0].ok, true);
  assert.equal(result.toolRuns[0].output.result, 5);

  assert.equal(ai.calls.length, 2);
  assert.equal(ai.calls[0].messages[0].role, 'system');
  assert.equal(ai.calls[0].messages[1].role, 'user');
  assert.equal(ai.calls[0].tools.length, 2);

  const toolMessage = ai.calls[1].messages.at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.toolCallId, 'call-1');
  assert.match(toolMessage.content, /"result":5/);

  assert.equal(usageLogs.length, 1);
  assert.equal(usageLogs[0].template, 'tool-chat');
  assert.equal(usageLogs[0].totalTokens, 30);
});

test('参数非法时把错误回填给模型，而不是中断请求', async () => {
  // Arrange
  const ai = createAiFake([
    {
      content: null,
      toolCalls: [
        {
          id: 'call-1',
          name: 'calculator',
          arguments: '{"operation":"divide","left":1,"right":0}',
        },
      ],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(8),
      finishReason: 'tool_calls',
    },
    {
      content: '除数不能为 0，请换一个数字。',
      toolCalls: [],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(9),
      finishReason: 'stop',
    },
  ]);
  const { prisma } = createPrismaFake();
  const service = new ToolChatService(ai, new ToolRegistry(), prisma);

  // Act
  const result = await service.chat('user-1', '1 除以 0 等于多少？');

  // Assert
  assert.equal(result.toolRuns[0].ok, false);
  assert.match(result.toolRuns[0].error, /除数不能为 0/);
  const toolMessage = ai.calls[1].messages.at(-1);
  assert.match(toolMessage.content, /"ok":false/);
  assert.match(result.reply, /不能为 0/);
});

test('未知工具同样回填错误，模型仍可给出最终回复', async () => {
  // Arrange
  const ai = createAiFake([
    {
      content: null,
      toolCalls: [{ id: 'call-1', name: 'shell', arguments: '{"cmd":"rm -rf /"}' }],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(5),
      finishReason: 'tool_calls',
    },
    {
      content: '这个工具不可用。',
      toolCalls: [],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(5),
      finishReason: 'stop',
    },
  ]);
  const service = new ToolChatService(ai, new ToolRegistry(), createPrismaFake().prisma);

  // Act
  const result = await service.chat('user-1', '执行 shell 命令');

  // Assert
  assert.equal(result.toolRuns[0].ok, false);
  assert.match(result.toolRuns[0].error, /未知工具/);
  assert.equal(result.reply, '这个工具不可用。');
});

test('模型反复调用工具时在轮次上限处停止', async () => {
  // Arrange
  const toolResult = {
    content: null,
    toolCalls: [
      {
        id: 'call-x',
        name: 'get_current_time',
        arguments: '{}',
      },
    ],
    model: 'deepseek-chat',
    profileId: 'deepseek-chat',
    usage: usage(1),
    finishReason: 'tool_calls',
  };
  const ai = createAiFake([toolResult, toolResult, toolResult, toolResult, toolResult]);
  const service = new ToolChatService(ai, new ToolRegistry(), createPrismaFake().prisma);

  // Act & Assert
  await assert.rejects(service.chat('user-1', '现在几点？'), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'AI_TOOL_LOOP_LIMIT');
    return true;
  });
  assert.equal(ai.calls.length, 4);
});

test('模型不需要工具时直接返回文本', async () => {
  // Arrange
  const ai = createAiFake([
    {
      content: '你好，有什么可以帮你？',
      toolCalls: [],
      model: 'deepseek-chat',
      profileId: 'deepseek-chat',
      usage: usage(4),
      finishReason: 'stop',
    },
  ]);
  const service = new ToolChatService(ai, new ToolRegistry(), createPrismaFake().prisma);

  // Act
  const result = await service.chat('user-1', '你好');

  // Assert
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.toolRuns, []);
  assert.equal(result.reply, '你好，有什么可以帮你？');
});

test('Transport 把工具定义原样发给模型，并解析 tool_calls', async () => {
  // Arrange
  let requestBody;
  const fakeFetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-tool',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'calculator',
                    arguments: '{"operation":"multiply","left":6,"right":7}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  const transport = new OpenAiChatTransport(defaultProfile(), fakeFetch);
  const registry = new ToolRegistry();

  // Act
  const result = await transport.completeWithTools(
    [
      { role: 'system', content: '可以调用工具' },
      { role: 'user', content: '6 乘 7 是多少？' },
    ],
    registry.getDefinitions(),
  );

  // Assert
  assert.equal(requestBody.tool_choice, 'auto');
  assert.equal(requestBody.tools.length, 2);
  assert.equal(requestBody.tools[1].function.name, 'calculator');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'calculator');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.usage.totalTokens, 28);
});
