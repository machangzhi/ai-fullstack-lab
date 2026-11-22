/**
 * 文件作用：知识库模块（Week 5 Day 6）。
 *
 * 模块内包含：
 * - KnowledgeController：上传与检索接口；
 * - KnowledgeService：解析→切片→向量化→入库的编排；
 * - EmbeddingGateway：Embedding 配置与客户端；
 * - VectorStoreService：pgvector 读写。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmbeddingGateway } from './embedding.gateway';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { VectorStoreService } from './vector-store.service';

@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [VectorStoreService, EmbeddingGateway, KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
