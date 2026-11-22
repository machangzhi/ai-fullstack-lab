/**
 * 文件作用：知识库上传与检索接口（Week 5 Day 6）。
 *
 * 两个接口：
 * - POST /api/knowledge/documents：multipart 上传，解析→切片→向量化→入库；
 * - POST /api/knowledge/search：问题向量化后做 Top-K 检索，返回来源信息。
 *
 * 文件只放内存，不落本地磁盘：解析完成后立即进入切片与向量化，
 * 失败时不会留下孤儿文件；大小与类型在进入业务逻辑前拦截。
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { extname } from 'node:path';
import { AppError } from '../../common/errors/app-error';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';
import { KnowledgeService } from './knowledge.service';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown']);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  @Post('documents')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '上传文档并完成解析、切片、向量化与入库' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
      fileFilter: (_request, file, callback) => {
        const extension = extname(file.originalname).toLowerCase();
        if (
          !ALLOWED_EXTENSIONS.has(extension) ||
          !ALLOWED_MIME_TYPES.has(file.mimetype)
        ) {
          callback(
            new AppError(
              `不支持的文件类型：${extension || file.mimetype}`,
              'KNOWLEDGE_UNSUPPORTED_FORMAT',
              400,
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  async ingest(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<Awaited<ReturnType<KnowledgeService['ingest']>>> {
    if (!file) {
      throw new AppError('缺少文件字段 file', 'KNOWLEDGE_EMPTY_FILE', 400);
    }

    return this.service.ingest({
      originalname: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
      size: file.size,
    });
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '按问题检索知识库，返回 Top-K 片段与来源' })
  async search(
    @Body() dto: SearchKnowledgeDto,
  ): Promise<Awaited<ReturnType<KnowledgeService['search']>>> {
    return this.service.search(dto);
  }
}
