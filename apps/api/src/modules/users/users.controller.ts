/**
 * 文件作用：用户控制器 UsersController。
 *
 * 关键概念：
 * 1. 路由设计（RESTful 风格）：
 *    - GET    /api/users       分页列表
 *    - GET    /api/users/:id   单个用户详情
 *    - POST   /api/users       创建用户
 * 2. 参数装饰器：
 *    - @Query()  取 URL query 参数（如 ?page=2）
 *    - @Param('id')  取路径参数（如 /users/u_001 中的 u_001）
 *    - @Body()  取请求体
 * 3. 返回值会被 ResponseInterceptor 包装成 { success, data, ... }。
 *    控制器方法直接返回业务数据即可，不用手动包结构。
 * 4. Swagger 注解：@ApiOperation 写接口摘要，@ApiOkResponse/@ApiCreatedResponse 写响应说明。
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Paginated } from '../../common/types/api-response';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { User } from './user.entity';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // GET /api/users?page=1&pageSize=10&keyword=xxx
  // 需要登录且角色为 ADMIN：用户列表包含全体用户信息，属于管理接口。
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: '分页查询用户（需 ADMIN）' })
  @ApiOkResponse({ description: '用户分页列表' })
  list(@Query() query: ListUsersQueryDto): Promise<Paginated<User>> {
    return this.usersService.list(query);
  }

  // GET /api/users/:id
  @Get(':id')
  @ApiOperation({ summary: '按 ID 查询用户' })
  findById(@Param('id') id: string): Promise<User> {
    return this.usersService.findById(id);
  }

  // POST /api/users
  @Post()
  @ApiOperation({ summary: '创建用户' })
  @ApiCreatedResponse({ description: '创建成功' })
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }
}
