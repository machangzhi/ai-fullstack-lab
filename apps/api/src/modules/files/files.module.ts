/**
 * 文件作用：文件模块。
 *
 * imports: [AuthModule] —— 上传接口用 JwtAuthGuard，守卫依赖 JwtService。
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesController } from './files.controller';

@Module({
  imports: [AuthModule],
  controllers: [FilesController],
})
export class FilesModule {}
