/**
 * 文件作用：统一 API 响应结构的类型定义。
 *
 * 关键概念：
 * 1. 为什么要统一响应结构？—— 前端调用接口时，无论成功失败，都按同一个格式解析，
 *    不用每个接口写一套判断逻辑。本项目约定：
 *    - 成功：{ success: true, data, requestId, timestamp }
 *    - 失败：{ success: false, error: { code, message, details? }, requestId, timestamp }
 * 2. ApiSuccess<T> / ApiFailure 用判别联合（discriminated union），TS 可以根据
 *    success 字段自动收窄类型，前端写 `if (body.success) { body.data }` 时类型安全。
 * 3. requestId、timestamp 由后端中间件/拦截器自动注入，业务代码不用管。
 * 4. Paginated<T> —— 分页响应结构，列表接口统一返回 items/total/page/pageSize/totalPages。
 */

// 成功响应：data 是业务数据，类型由泛型 T 指定。
export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

// 失败响应：error 对象包含稳定 code、可读 message、可选 details（如校验错误明细）。
export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}

// 联合类型：ApiResponse<T> 要么成功要么失败。
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

// 分页查询参数：page 从 1 开始，pageSize 每页条数。
export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

// 分页结果：items 是当前页数据，total 是总条数，totalPages 是总页数。
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
