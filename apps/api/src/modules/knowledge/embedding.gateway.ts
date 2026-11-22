/**
 * 文件作用：Embedding 网关（Week 5 Day 6）。
 *
 * 把「解析配置 → 创建客户端 → 批量调用」收敛到一个可替换的依赖，
 * 让 KnowledgeService 可以在测试里注入 Mock，不需要真实密钥与网络。
 */

import { Injectable } from '@nestjs/common';
import {
  createEmbeddingClient,
  embedTexts,
  resolveEmbeddingConfig,
  type EmbedTextsResult,
} from '@ai-lab/rag';

@Injectable()
export class EmbeddingGateway {
  async embed(texts: string[]): Promise<EmbedTextsResult> {
    const config = resolveEmbeddingConfig(process.env);
    const client = createEmbeddingClient(config);
    return embedTexts(texts, client, { batchSize: config.batchSize });
  }
}
