/**
 * 文件作用：受限文件上传接口（POST /api/files/upload）。
 *
 * 四道防线，缺一不可：
 * 1. **MIME 白名单**：只接受明确列出的类型。黑名单（拒绝 .exe）永远列不全。
 * 2. **大小限制**：Multer 的 limits.fileSize，超出直接 413，不读到内存里再判断。
 * 3. **文件名由服务端生成**：扩展名从 MIME 映射表取，**绝不用客户端文件名**。
 *    否则 `../../etc/passwd` 这类路径穿越、`shell.php.jpg` 这类双扩展名都会进来。
 * 4. **登录校验**：未登录不能上传（防止被当作免费图床刷满磁盘）。
 *
 * 注意：MIME 由客户端声明，可伪造。真正严格的场景要读文件头（magic number）校验，
 * 生产还应把文件存到对象存储（OSS/S3）而不是本地磁盘。这两点记入技术债。
 */

import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { diskStorage } from 'multer';
import { extname, join, parse } from 'node:path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/** 允许的类型 → 落盘扩展名。扩展名只从这里取，不从原文件名取。 */
const ALLOWED_TYPES = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
]);

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** 上传目录：可通过环境变量覆盖，默认在应用工作目录下的 uploads/。 */
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '上传文件（≤5MB，白名单类型）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, callback) => {
          if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
          callback(null, UPLOAD_DIR);
        },
        filename: (_req, file, callback) => {
          // 安全关键：扩展名来自白名单映射，文件名用随机 UUID。
          const ext = ALLOWED_TYPES.get(file.mimetype) ?? '';
          callback(null, `${randomUUID()}${ext}`);
        },
      }),
      limits: { fileSize: MAX_SIZE_BYTES, files: 1 },
      fileFilter: (_req, file, callback) => {
        if (!ALLOWED_TYPES.has(file.mimetype)) {
          callback(new BadRequestException(`不支持的文件类型：${file.mimetype}`), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('缺少文件字段 file');
    }

    // 只返回必要元数据；文件内容如何访问由后续的静态托管 / 签名 URL 决定。
    const storedName = file.filename;
    const ext = extname(storedName);
    return {
      id: parse(storedName).name,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
      storedName,
      ext,
    };
  }
}
