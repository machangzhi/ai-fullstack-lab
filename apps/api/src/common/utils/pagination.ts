/**
 * 文件作用：分页工具函数。
 *
 * 关键概念：
 * 1. normalizePagination —— 把前端传来的 page/pageSize 做边界校正：
 *    - page 最小 1（Math.max(1, ...)），防止负数或 0。
 *    - pageSize 最小 1、最大 100，防止一次拉太多数据把库打爆。
 *    - Math.trunc 去掉小数（防止传 1.5 这种）。
 *    - 算出 skip（跳过多少条）和 take（取多少条），方便直接传给 Prisma/TypeORM。
 * 2. paginate —— 对内存数组做分页切片（第 1 周 UsersService 用内存数组，所以直接用这个）。
 *    第 2 周换 Prisma 后，数据库直接用 skip/take，不再需要在内存里 slice。
 * 3. 为什么 skip = (page - 1) * pageSize？—— 第 1 页跳过 0 条，第 2 页跳过 pageSize 条，以此类推。
 */

import { Paginated, PaginationQuery } from '../types/api-response';

// 分页默认值与上限。
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

// 归一化后的分页参数，skip/take 可直接用于数据库查询。
export interface NormalizedPagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function normalizePagination(query: PaginationQuery): NormalizedPagination {
  // page：默认 1，最小 1，取整。
  const page = Math.max(1, Math.trunc(query.page ?? DEFAULT_PAGE));
  // pageSize：默认 10，最小 1，最大 100，取整。
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  // skip：前面跳过多少条；take：本页取多少条。
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// 对数组做分页切片，返回标准 Paginated<T> 结构。
export function paginate<T>(items: T[], query: PaginationQuery): Paginated<T> {
  const { page, pageSize, skip, take } = normalizePagination(query);
  const total = items.length;

  return {
    items: items.slice(skip, skip + take),
    total,
    page,
    pageSize,
    // 总页数：向上取整（9 条 / 10 每页 = 1 页；11 条 / 10 每页 = 2 页）。
    totalPages: Math.ceil(total / pageSize),
  };
}
