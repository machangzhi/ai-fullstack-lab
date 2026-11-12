/**
 * 文件作用：NestJS 应用启动入口（bootstrap）。
 *
 * 关键概念：
 * 1. NestFactory.create(AppModule) —— 基于根模块创建应用实例，相当于把所有模块、控制器、服务
 *    组装成一个可运行的 HTTP 服务（底层是 Express 或 Fastify，这里用默认的 Express）。
 * 2. 全局中间件/管道/拦截器/过滤器 —— 在 main.ts 里统一挂载，作用于所有路由，避免在每个模块重复配置。
 * 3. setGlobalPrefix('api') —— 所有接口统一以 /api 开头，便于前端代理与网关路由。
 * 4. Swagger —— 自动根据 Controller 与 DTO 生成接口文档，访问 /docs。
 * 5. ConfigService —— 从 .env 文件读取环境变量（由 AppModule 中的 ConfigModule 加载）。
 */

// reflect-metadata：NestJS 的依赖注入（DI）依赖装饰器元数据，必须在应用启动最前面引入一次。
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';

// bootstrap：异步启动函数。NestJS 官方推荐用 async 函数包裹启动逻辑，便于 await app.listen。
async function bootstrap(): Promise<void> {
  // 创建应用实例。AppModule 是根模块，所有子模块都要在它的 imports 中注册。
  const app = await NestFactory.create(AppModule);

  // 从 IoC 容器中取出 ConfigService 实例，用于读取环境变量。
  const configService = app.get(ConfigService);

  // 读取端口，默认 3000。configService.get 的第二个参数是默认值。
  const port = Number(configService.get<string>('PORT', '3000'));

  // CORS 白名单：支持逗号分隔的多个来源，默认放行前端开发地址 http://localhost:5173。
  // trim + filter(Boolean) 是为了去除空字符串和多余空格。
  const corsOrigins = (configService.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // 全局路由前缀：所有接口变成 /api/xxx。
  app.setGlobalPrefix('api');

  // 请求 ID 中间件：为每个请求分配/透传 requestId，方便日志追踪与统一响应结构使用。
  // 这里用 app.use 挂函数式中间件（而非 NestMiddleware 类），更轻量。
  app.use(requestIdMiddleware);

  // 启用 CORS：credentials=true 表示允许携带 Cookie（后续登录态会用到）。
  app.enableCors({ origin: corsOrigins, credentials: true });

  // 全局校验管道：基于 class-validator + class-transformer。
  // - whitelist: 自动剥离 DTO 中未声明的属性，防止脏数据入库。
  // - transform: 把 query/param/body 自动转成 DTO 实例（如字符串 '1' 转成数字 1）。
  // - forbidNonWhitelisted: 出现未声明属性时直接抛 400，而不是静默丢弃。
  // - enableImplicitConversion: false 表示不隐式转换，必须在 DTO 上显式写 @Type(() => Number)。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // 全局响应拦截器：把所有成功响应包装成 { success, data, requestId, timestamp }。
  app.useGlobalInterceptors(new ResponseInterceptor());

  // 全局异常过滤器：把所有抛出的异常转成统一的失败结构 { success:false, error:{...} }。
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger 文档配置：标题、描述、版本。第 1 周的描述就是当前阶段的内容。
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ai-fullstack-lab API')
    .setDescription('第 1 周：工程骨架、健康检查、用户与配置接口')
    .setVersion('0.1.0')
    .build();

  // 根据当前应用生成 OpenAPI 文档对象。
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // 把文档挂载到 /docs 路径，浏览器访问 http://localhost:3000/docs 即可查看。
  SwaggerModule.setup('docs', app, document);

  // 启动 HTTP 服务并监听端口。
  await app.listen(port);

  // 用 Logger 输出启动信息，比 console.log 更规范，会带上下文标签 'Bootstrap'。
  Logger.log(`API: http://localhost:${port}/api`, 'Bootstrap');
  Logger.log(`Swagger: http://localhost:${port}/docs`, 'Bootstrap');
}

// void 运算符：忽略 Promise 的返回值，告诉 TS "我知道这是个 Promise，不需要处理它"。
void bootstrap();
