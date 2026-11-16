/**
 * 文件作用：扩展 Express 的 Request 类型，增加 requestId 字段。
 *
 * 关键概念：
 * 1. TypeScript 模块声明合并（declaration merging）：通过 `declare module 'express'` 可以
 *    给第三方库的已有类型追加属性。这里给 Express 的 Request 接口加上 requestId: string。
 * 2. 为什么是 'express' 而不是 'express-serve-static-core'？—— 不同 Express 版本内部类型
 *    组织方式不同，在本项目中声明 'express' 生效（见 Errors & Resolutions #4）。
 * 3. request-id.middleware.ts 中给 req.requestId 赋值，其他地方（拦截器/过滤器）读取它，
 *    都依赖这个类型扩展，否则 TS 会报错 "Property 'requestId' does not exist on type 'Request'"。
 * 4. 这个文件是 .d.ts（声明文件），只含类型，不含运行时代码，不产生编译产物。
 *    tsconfig.json 的 include 必须包含 src 目录下所有 .d.ts 文件，否则扩展不生效。
 */

import 'express';
import type { JwtPayload } from '../../modules/auth/types/jwt-payload';

// 声明合并：在 Express 的 Request 接口上追加 requestId 字段。
declare module 'express' {
  interface Request {
    requestId: string;
    /**
     * 当前登录用户。由 JwtAuthGuard 在验签通过后写入，
     * 只对标注了 @UseGuards(JwtAuthGuard) 的路由有值。
     */
    user?: JwtPayload;
    /**
     * 登录限流用的计数 key（IP + 邮箱）。
     * 由 LoginThrottleGuard 写入，AuthService 用它记录失败次数，避免两边重复计算。
     */
    loginKey?: string;
  }
}
