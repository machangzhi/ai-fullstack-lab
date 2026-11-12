/**
 * 文件作用：系统配置控制器 SystemController。
 *
 * 关键概念：
 * 1. @Controller('config') —— 路由前缀 /config，最终路径 /api/config。
 * 2. 这个接口是公开的（不需要鉴权），因为前端启动时就要拉取，此时用户还没登录。
 *    但返回内容已经在 SystemService 里做了白名单，不含敏感信息。
 * 3. 后续接入鉴权后，可以给其他需要登录的接口加 @UseGuards(JwtAuthGuard)，
 *    而 /api/config 保持公开。
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RuntimeConfig, SystemService } from './system.service';

@ApiTags('system')
@Controller('config')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get() // GET /api/config
  @ApiOperation({ summary: '获取可公开的运行配置（不含任何密钥）' })
  @ApiOkResponse({ description: '公开配置' })
  getConfig(): RuntimeConfig {
    return this.systemService.getRuntimeConfig();
  }
}
