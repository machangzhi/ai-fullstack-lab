/**
 * 文件作用：ai-core 的公共入口，提供模型供应商配置与多模型档案解析能力。
 *
 * 关键概念：
 * 1. Provider（模型供应商）只描述“连接谁、使用哪个模型、如何采样”，不在这里发请求。
 *    Week 4 Day 1 起，档案（profile）在同一份基础配置上声明多个可切换模型。
 * 2. resolveModelProviderConfig / resolveModelProfiles 都是纯函数：环境对象通过参数注入，
 *    因此测试不需要读取本机 .env，也不会访问网络。生产代码可不传参数，默认读取 process.env。
 * 3. 配置对象含 apiKey，只能在服务端内部使用；返回给浏览器前必须经过
 *    toPublicModelProviderConfig / toPublicModelProfile 白名单脱敏，不能直接序列化完整配置。
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

/* -------------------------------------------------------------------------- */
/* 多模型档案（Week 4 Day 1）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 模型能力差异。前端据此展示提示，服务端据此做预算与功能判断；
 * 它不是供应商能力的完整清单，只记录当前业务真正用到的字段。
 */
export interface ModelCapabilities {
  /** 是否支持流式输出；不支持时后续可以降级为一次性返回。 */
  streaming: boolean;
  /** 上下文窗口（Token），用于 Day 2 的上下文预算与历史裁剪。 */
  contextWindow: number;
}

/** 服务端内部使用的模型档案：在完整配置上增加公开别名与展示名称。 */
export interface ModelProfileConfig extends ModelProviderConfig {
  /** 公开别名，客户端只能用它切换模型，不能提交模型地址或密钥。 */
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

/** 可安全返回给浏览器的档案信息，字段采用白名单。 */
export interface PublicModelProfile {
  id: string;
  label: string;
  provider: ModelProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  capabilities: ModelCapabilities;
}

/** 一次解析得到的档案集合；defaultProfileId 必须存在于 profiles 中。 */
export interface ModelProfileRegistry {
  defaultProfileId: string;
  profiles: ModelProfileConfig[];
}

const DEFAULT_CONTEXT_WINDOW = 32_768;
const MAX_MODEL_PROFILES = 8;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const API_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** 把公开别名映射为环境变量前缀，例如 deepseek-chat -> MODEL_PROFILE_DEEPSEEK_CHAT_。 */
function profileEnvPrefix(id: string): string {
  return `MODEL_PROFILE_${id.toUpperCase().replace(/-/g, '_')}_`;
}

function readBoolean(env: ModelProviderEnvironment, name: string, defaultValue: boolean): boolean {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  // 只报变量名与允许值，避免把配置内容写进日志。
  throw new Error(`${name} must be true or false.`);
}

/** 解析单个档案；未声明的字段全部继承基础 ModelProvider 配置。 */
function resolveModelProfile(
  id: string,
  base: ModelProviderConfig,
  env: ModelProviderEnvironment,
): ModelProfileConfig {
  const prefix = profileEnvPrefix(id);
  const providerRaw = readOptional(env, `${prefix}PROVIDER`);
  const provider = providerRaw === undefined ? base.provider : parseProvider(providerRaw);
  const baseUrlRaw = readOptional(env, `${prefix}BASE_URL`);
  const modelRaw = readOptional(env, `${prefix}MODEL`);

  // 换供应商却不换地址，会把请求（连同密钥）发到错误的服务，因此必须显式覆盖。
  if (provider !== base.provider && baseUrlRaw === undefined) {
    throw new Error(`${prefix}BASE_URL is required when changing provider.`);
  }
  if (provider !== base.provider && modelRaw === undefined) {
    throw new Error(`${prefix}MODEL is required when changing provider.`);
  }

  const apiKeyEnv = readOptional(env, `${prefix}API_KEY_ENV`);
  let apiKey = base.apiKey;
  if (apiKeyEnv !== undefined) {
    if (!API_KEY_ENV_PATTERN.test(apiKeyEnv)) {
      throw new Error(`${prefix}API_KEY_ENV must be an environment variable name.`);
    }
    // 档案里只写变量名，真正的密钥仍然只存在于环境变量中。
    apiKey = readRequired(env, apiKeyEnv);
  }

  return {
    id,
    label: readOptional(env, `${prefix}LABEL`) ?? modelRaw ?? base.model,
    provider,
    baseUrl: baseUrlRaw === undefined ? base.baseUrl : normalizeBaseUrl(baseUrlRaw),
    model: modelRaw ?? base.model,
    apiKey,
    temperature: readNumber(env, `${prefix}TEMPERATURE`, base.temperature, {
      min: 0,
      max: 2,
    }),
    maxTokens: readNumber(env, `${prefix}MAX_TOKENS`, base.maxTokens, {
      min: 1,
      integer: true,
    }),
    timeoutMs: readNumber(env, `${prefix}TIMEOUT_MS`, base.timeoutMs, {
      min: 1,
      integer: true,
    }),
    capabilities: {
      streaming: readBoolean(env, `${prefix}STREAMING`, true),
      contextWindow: readNumber(env, `${prefix}CONTEXT_WINDOW`, DEFAULT_CONTEXT_WINDOW, {
        min: 1,
        integer: true,
      }),
    },
  };
}

/**
 * 从环境变量解析可切换的模型档案。
 *
 * 未配置 MODEL_PROFILES 时自动生成一个 id=default 的档案，保持 Week 3 的单模型用法；
 * 配置后每个档案继承 MODEL_PROVIDER / MODEL_BASE_URL / MODEL_API_KEY 等基础配置，
 * 只覆盖 MODEL_PROFILE_<ID>_MODEL 等必要字段。
 */
export function resolveModelProfiles(
  env: ModelProviderEnvironment = process.env,
): ModelProfileRegistry {
  const base = resolveModelProviderConfig(env);
  const rawIds = readOptional(env, 'MODEL_PROFILES');
  const ids =
    rawIds === undefined
      ? ['default']
      : rawIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);

  if (ids.length === 0) {
    throw new Error('MODEL_PROFILES must contain at least one profile id.');
  }
  if (ids.length > MAX_MODEL_PROFILES) {
    throw new Error(`MODEL_PROFILES supports at most ${MAX_MODEL_PROFILES} profiles.`);
  }

  const seen = new Set<string>();
  const profiles = ids.map((id) => {
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid model profile id "${id}": use 1-32 lowercase letters, digits or hyphens.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate model profile id: ${id}.`);
    }
    seen.add(id);
    return resolveModelProfile(id, base, env);
  });

  const defaultProfileId = readOptional(env, 'MODEL_DEFAULT_PROFILE') ?? profiles[0].id;
  if (!profiles.some((profile) => profile.id === defaultProfileId)) {
    throw new Error('MODEL_DEFAULT_PROFILE must reference one of MODEL_PROFILES.');
  }

  return { defaultProfileId, profiles };
}

/** 按公开别名取档案；不传时返回默认档案。找不到属于配置错误，必须显式失败。 */
export function selectModelProfile(
  registry: ModelProfileRegistry,
  profileId?: string,
): ModelProfileConfig {
  const id = profileId ?? registry.defaultProfileId;
  const profile = registry.profiles.find((item) => item.id === id);
  if (!profile) {
    throw new Error(`Unknown model profile: ${id}.`);
  }
  return profile;
}

/** 生成可公开的档案信息：排除 apiKey、baseUrl 和 timeoutMs。 */
export function toPublicModelProfile(profile: ModelProfileConfig): PublicModelProfile {
  return {
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    capabilities: profile.capabilities,
  };
}
