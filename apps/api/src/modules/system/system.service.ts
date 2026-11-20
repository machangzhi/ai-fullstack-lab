/**
 * 文件作用：系统配置服务 SystemService。
 *
 * 关键概念：
 * 1. 为什么要有 /api/config 接口？—— 前端启动时需要知道一些运行时信息（应用名、环境、
 *    版本、模型供应商、功能开关），但又不能把这些硬编码在前端包里（那样每次改都要重新打包）。
 *    所以由后端提供一个公开接口，前端启动时拉取。
 * 2. 安全原则：这个接口只返回"可以公开的信息"，绝对不返回任何密钥（API Key、数据库密码等）。
 *    密钥只存在服务端环境变量里，通过 ConfigService 读取，从不暴露给前端。
 * 3. features 字段 —— 功能开关，第 1 周全是 false，后续每周接入对应能力后改成 true，
 *    前端据此显示/隐藏对应 UI。
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// 可公开的运行配置结构。
export interface RuntimeConfig {
  appName: string; // 应用名
  env: string; // 环境：development / production
  version: string; // 版本号
  modelProvider: string; // 模型供应商标识
  modelName: string; // 应用请求的模型名（不含地址与密钥）
  features: {
    chat: boolean; // AI 对话功能
    rag: boolean; // RAG 知识库功能
    agent: boolean; // Agent 功能
  };
}

@Injectable()
export class SystemService {
  // 注入 ConfigService，用于读取环境变量。
  constructor(private readonly configService: ConfigService) {}

  getRuntimeConfig(): RuntimeConfig {
    return {
      appName: this.configService.get<string>('APP_NAME', 'ai-fullstack-lab-api'),
      env: this.configService.get<string>('APP_ENV', 'development'),
      version: this.configService.get<string>('APP_VERSION', '0.1.0'),
      modelProvider: this.configService.get<string>('MODEL_PROVIDER', 'openai-compatible'),
      modelName: this.configService.get<string>('MODEL_NAME', 'deepseek-chat'),
      // Week 3 Day 2 接入单轮非流式对话；RAG 与 Agent 仍按后续计划开启。
      features: {
        chat: true,
        rag: false,
        agent: false,
      },
    };
  }
}
