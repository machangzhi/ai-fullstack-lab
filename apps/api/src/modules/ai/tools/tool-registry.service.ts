/**
 * 文件作用：工具注册表与执行边界（Week 4 Day 3）。
 *
 * 关键概念：
 * 1. 模型只负责「选择工具 + 给参数」，工具是否可执行由服务端决定。
 * 2. 注册表是唯一真相：模型看到的 JSON Schema 与执行前的 Zod 校验来自同一份定义，
 *    避免“描述允许、代码不接受”的不一致。
 * 3. 参数永远按不可信输入处理：长度限制、JSON 解析、严格 schema、未知字段拒绝。
 * 4. 执行有超时与错误隔离；工具失败只回传一条 tool 消息，不把异常抛给整个请求。
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ToolDefinition } from '../openai-chat.transport';

const TOOL_TIMEOUT_MS = 2000;
const MAX_ARGUMENT_CHARS = 4000;

const timeSchema = z
  .object({
    timezone: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_+\-/]+$/, 'timezone 只能包含字母、数字、下划线、加号、斜杠和连字符')
      .optional(),
  })
  .strict();

const calculatorSchema = z
  .object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    left: z.number(),
    right: z.number(),
  })
  .strict();

type TimeInput = z.infer<typeof timeSchema>;
type CalculatorInput = z.infer<typeof calculatorSchema>;

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

interface RegisteredTool {
  definition: ToolDefinition;
  schema: z.ZodType;
  run: (input: unknown) => unknown | Promise<unknown>;
}

function getCurrentTime(input: TimeInput): Record<string, string> {
  const timezone = input.timezone ?? 'Asia/Shanghai';
  const now = new Date();

  // Intl 自己会校验 IANA 时区；非法时区抛出 RangeError，由 execute 统一隔离。
  const local = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(now);

  return { timezone, iso: now.toISOString(), local };
}

function calculate(input: CalculatorInput): Record<string, number | string> {
  const { operation, left, right } = input;

  if (operation === 'divide' && right === 0) {
    throw new Error('除数不能为 0。');
  }

  const result =
    operation === 'add'
      ? left + right
      : operation === 'subtract'
        ? left - right
        : operation === 'multiply'
          ? left * right
          : left / right;

  if (!Number.isFinite(result)) {
    throw new Error('计算结果不是有限数字，请检查输入。');
  }

  return { operation, left, right, result };
}

@Injectable()
export class ToolRegistry {
  private readonly tools: RegisteredTool[] = [
    {
      definition: {
        name: 'get_current_time',
        description:
          '获取指定时区的当前日期与时间。涉及“现在几点、今天几号、当前时间”等问题时必须调用，不要凭记忆猜测。',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                'IANA 时区名，例如 Asia/Shanghai、America/New_York；不传时默认 Asia/Shanghai',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      schema: timeSchema,
      run: (input) => getCurrentTime(timeSchema.parse(input)),
    },
    {
      definition: {
        name: 'calculator',
        description:
          '执行两个数字之间的四则运算。涉及加减乘除时必须调用，不要心算；除法除数为 0 会返回错误。',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['add', 'subtract', 'multiply', 'divide'],
              description: 'add=加，subtract=减，multiply=乘，divide=除',
            },
            left: { type: 'number', description: '左操作数' },
            right: { type: 'number', description: '右操作数' },
          },
          required: ['operation', 'left', 'right'],
          additionalProperties: false,
        },
      },
      schema: calculatorSchema,
      run: (input) => calculate(calculatorSchema.parse(input)),
    },
  ];

  /** 返回给模型的工具目录副本，防止调用方修改注册表。 */
  getDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => tool.definition);
  }

  async execute(name: string, rawArguments: string): Promise<ToolExecutionResult> {
    const tool = this.tools.find((item) => item.definition.name === name);
    if (!tool) {
      return { ok: false, error: `未知工具：${name.slice(0, 64)}` };
    }

    if (rawArguments.length > MAX_ARGUMENT_CHARS) {
      return { ok: false, error: '工具参数过长。' };
    }

    let parsedJson: unknown;
    try {
      // 无参数工具可能收到空字符串，等价于空对象。
      parsedJson = JSON.parse(rawArguments.trim() || '{}');
    } catch {
      return { ok: false, error: '工具参数不是合法 JSON。' };
    }

    const parsed = tool.schema.safeParse(parsedJson);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; ');
      return { ok: false, error: `参数不合法：${detail}` };
    }

    try {
      const output = await this.withTimeout(Promise.resolve(tool.run(parsed.data)));
      return { ok: true, output };
    } catch (error) {
      // 只回传受控的错误描述；堆栈与内部路径不进入模型上下文。
      const message = error instanceof Error ? error.message : '工具执行失败。';
      return { ok: false, error: message.slice(0, 300) };
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('工具执行超时。')), TOOL_TIMEOUT_MS);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
