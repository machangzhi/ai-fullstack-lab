/**
 * 文件作用：知识库模块（Week 5 Day 5）。
 *
 * 当前只注册 VectorStoreService；Day 6 会在同一模块里加入解析、切片、
 * Embedding 与 ingestion 流程，最终暴露 /knowledge 相关接口。
 */

import { Module } from '@nestjs/common';
import { VectorStoreService } from './vector-store.service';

@Module({
  providers: [VectorStoreService],
  exports: [VectorStoreService],
})
export class KnowledgeModule {}
