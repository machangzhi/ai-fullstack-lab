/**
 * 文件作用：ai-core 的公共入口，目前提供 ModelProvider 配置解析与脱敏能力。
 *
 * 关键概念：
 * 1. Provider（模型供应商）只描述“连接谁、使用哪个模型、如何采样”，不在这里发请求。
 *    Day 2 会基于这份配置创建客户端；Week 4 再扩展统一的 LLMService 与调用接口。
 * 2. resolveModelProviderConfig 是纯函数：环境对象通过参数注入，因此测试不需要读取本机
 *    .env，也不会访问网络。生产代码可不传参数，默认读取 process.env。
 * 3. 配置对象含 apiKey，只能在服务端内部使用；返回给浏览器前必须经过
 *    toPublicModelProviderConfig 白名单脱敏，不能直接序列化完整配置。
 * 4. openai-compatible 是通用协议名称，不默认指向某家服务，避免把密钥误发到未知地址；
 *    deepseek 有明确的官方默认值，因此只配置 MODEL_PROVIDER 与 MODEL_API_KEY 即可切换。
 */

export * from './prompts';
export * from './structured';

export const SUPPORTED_MODEL_PROVIDERS = ['openai-compatible', 'deepseek'] as const;

export type ModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

/** 环境变量的最小结构，与 Node.js 的 ProcessEnv 兼容，同时方便单元测试注入。 */
export type ModelProviderEnvironment = Record<string, string | undefined>;

/** 服务端内部使用的完整模型配置。禁止把该对象整体返回给客户端或写入日志。 */
export interface ModelProviderConfig {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * 可公开配置采用白名单，而不是简单地只删除 apiKey：
 * baseUrl 可能暴露内网地址，timeoutMs 也属于客户端无需了解的运维细节。
 */
export type PublicModelProviderConfig = Pick<
  ModelProviderConfig,
  'provider' | 'model' | 'temperature' | 'maxTokens'
>;

interface ProviderPreset {
  baseUrl?: string;
  model?: string;
}

const PROVIDER_PRESETS: Record<ModelProvider, ProviderPreset> = {
  // 通用 OpenAI 兼容服务必须显式提供地址与模型，不猜测供应商。
  'openai-compatible': {},
  // DeepSeek 官方兼容地址与默认对话模型，仍允许通过环境变量覆盖。
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
};

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;

function readOptional(env: ModelProviderEnvironment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readRequired(env: ModelProviderEnvironment, name: string): string {
  const value = readOptional(env, name);
  if (!value) {
    // 错误信息只包含变量名，不包含变量值，避免密钥进入异常日志。
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

function parseProvider(value: string | undefined): ModelProvider {
  const provider = value ?? 'openai-compatible';
  if ((SUPPORTED_MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as ModelProvider;
  }
  throw new Error(`MODEL_PROVIDER must be one of: ${SUPPORTED_MODEL_PROVIDERS.join(', ')}.`);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MODEL_BASE_URL must be a valid absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('MODEL_BASE_URL only supports http:// or https:// URLs.');
  }
  if (url.username || url.password) {
    throw new Error('MODEL_BASE_URL must not contain username or password.');
  }

  // 统一移除末尾斜杠，避免 Day 2 拼接 /chat/completions 时出现双斜杠。
  return url.toString().replace(/\/+$/, '');
}

interface NumberRule {
  min: number;
  max?: number;
  integer?: boolean;
}

function readNumber(
  env: ModelProviderEnvironment,
  name: string,
  defaultValue: number,
  rule: NumberRule,
): number {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    return defaultValue;
  }

  const value = Number(raw);
  const isValid =
    Number.isFinite(value) &&
    value >= rule.min &&
    (rule.max === undefined || value <= rule.max) &&
    (!rule.integer || Number.isInteger(value));

  if (!isValid) {
    const range = rule.max === undefined ? `>= ${rule.min}` : `${rule.min} to ${rule.max}`;
    const typeHint = rule.integer ? 'an integer' : 'a number';
    throw new Error(`${name} must be ${typeHint} in range ${range}.`);
  }
  return value;
}

/**
 * 从环境变量生成完整模型配置。只解析与校验，不发起网络请求。
 * 切换供应商时业务代码不变，只需修改 MODEL_PROVIDER 及对应环境变量。
 */
export function resolveModelProviderConfig(
  env: ModelProviderEnvironment = process.env,
): ModelProviderConfig {
  const provider = parseProvider(readOptional(env, 'MODEL_PROVIDER'));
  const preset = PROVIDER_PRESETS[provider];
  const baseUrl = readOptional(env, 'MODEL_BASE_URL') ?? preset.baseUrl;
  const model = readOptional(env, 'MODEL_NAME') ?? preset.model;

  return {
    provider,
    baseUrl: normalizeBaseUrl(baseUrl ?? readRequired(env, 'MODEL_BASE_URL')),
    model: model ?? readRequired(env, 'MODEL_NAME'),
    apiKey: readRequired(env, 'MODEL_API_KEY'),
    temperature: readNumber(env, 'MODEL_TEMPERATURE', DEFAULT_TEMPERATURE, {
      min: 0,
      max: 2,
    }),
    maxTokens: readNumber(env, 'MODEL_MAX_TOKENS', DEFAULT_MAX_TOKENS, {
      min: 1,
      integer: true,
    }),
    timeoutMs: readNumber(env, 'MODEL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, {
      min: 1,
      integer: true,
    }),
  };
}

/** 生成可安全返回给浏览器的模型配置，永远不携带密钥和内网连接信息。 */
export function toPublicModelProviderConfig(
  config: ModelProviderConfig,
): PublicModelProviderConfig {
  return {
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}
