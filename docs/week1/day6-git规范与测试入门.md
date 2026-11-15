# Day 6 笔记：Git 规范与测试入门

> 日期：2026-11-15
> 对应计划：第 1 周 · Day 6 —— 分支模型、commit 规范、合并策略、Jest 入门、单元测试与 e2e
> 编码练习：给核心工具函数补单测、跑通第一条 e2e

## 0. 一句话总结

**Git 让"改了什么"可追溯，测试让"改坏没有"可验证。** 前者管历史，后者管未来。

---

## 1. 分支模型：四种，选一种就够

| 模型 | 结构 | 适用场景 |
| --- | --- | --- |
| GitHub Flow | main + 短命 feature 分支 + PR | 持续部署的 SaaS |
| GitLab Flow | main + 环境分支（staging / production） | 需要多环境隔离 |
| GitFlow | main / develop + feature / release / hotfix | 版本化发布（App、SDK、私有部署） |
| 每周分支 | `weekN` 隔离一周成果，完成即合并 | 节奏清晰的迭代/学习计划 |

### 1.1 本项目的实际形态

```
* 0425567 docs: add week1 day4 notes on nestjs fundamentals
* 4d20e3a docs: add week1 day2-day3 notes on typescript and node async
* b1d5255 docs: add week1 day1 notes on env and project init
* 49b946c feat: support SWAGGER_SERVER_URL for subpath deployment
* 3e13ce2 fix: separate vite base and swagger url for dev/prod
* a762fcf fix: swagger link uses BASE_URL to support /lab/ subpath
*   46879d7 merge: sync backend port change to week1   ← 合并节点
```

为什么选每周分支：

1. **一个分支 = 一次可验收的交付**，合并到 master 就是"这周完成"的客观证据；
2. 出问题可以整周回滚，不影响其它周；
3. 合并节点天然形成周报素材。

---

## 2. Commit 规范：Conventional Commits

格式：

```
type(scope): subject
```

| type | 含义 | 触发版本号 |
| --- | --- | --- |
| `feat` | 新功能 | minor |
| `fix` | 修 bug | patch |
| `docs` | 只改文档 | 无 |
| `refactor` | 重构，行为不变 | 无 |
| `perf` | 性能优化 | patch |
| `test` | 增加/修改测试 | 无 |
| `chore` | 构建、依赖、脚手架 | 无 |
| `BREAKING CHANGE` | 不兼容变更 | major |

### 2.1 好与坏

```
✅ feat: support SWAGGER_SERVER_URL for subpath deployment
✅ fix: separate vite base and swagger url for dev/prod
✅ docs: add week1 day5 notes on api spec
✅ test: cover pagination boundary cases

❌ update code
❌ 修改
❌ fix bug
❌ 111
```

### 2.2 为什么值得遵守

1. `git log --grep="^fix"` 直接捞出所有修复，写复盘不用回忆；
2. 能自动生成 CHANGELOG 和语义化版本；
3. Code Review 时，`fix` 和 `feat` 的审查标准不同（前者要问"根因是什么"，后者要问"边界考虑了吗"）。

### 2.3 提交粒度

**一个 commit 做一件事。** 判据：能否用一句话描述且不需要"和"字。

```
❌ feat: add login page and fix nginx config and update readme
✅ feat: add login page
✅ fix: correct nginx proxy path
✅ docs: update readme
```

好处：`git revert` 粒度精确、`git bisect` 定位准确、review 更聚焦。

---

## 3. 合并策略

| 策略 | 历史 | 优点 | 缺点 | 适用 |
| --- | --- | --- | --- | --- |
| `--no-ff` | 保留分叉 + 合并节点 | 保留"这周做了什么" | 图变复杂 | 每周分支（本项目） |
| `--squash` | 压成一条 | 主干干净 | 丢失过程 | 实验性分支 |
| `rebase` | 线性 | 最干净 | 改写历史 | 单人分支、未推送 |

### 3.1 为什么已推送的分支不能 rebase

rebase 会**重建提交对象**（新的 SHA），协作者本地的旧提交与新历史分叉，pull 时要么冲突、要么重复提交。团队协作的代价远大于历史美观的收益。

**唯一安全的情况**：只属于你、且没人基于它开发的分支。

### 3.2 合并冲突的标准流程

```bash
git merge week1                 # 冲突
git status                      # 看哪些文件冲突
# 手动编辑，删掉 <<<<<<< ======= >>>>>>> 标记
git add <file>
git merge --continue
```

冲突标记里 `HEAD` 是当前分支，另一侧是被合入的分支。**不要直接删掉一侧了事**，先理解两边都在改什么。

---

## 4. 急救命令表

| 场景 | 命令 | 安全性 |
| --- | --- | --- |
| 丢弃工作区某个文件改动 | `git restore <file>` | 破坏性（未提交内容丢失） |
| 暂存当前改动去处理别的事 | `git stash` / `git stash pop` | 安全 |
| 修改最后一次提交（未推送） | `git commit --amend` | 安全 |
| 撤回提交但保留改动到暂存区 | `git reset --soft HEAD~1` | 安全 |
| 撤回提交并保留改动到工作区 | `git reset --mixed HEAD~1` | 安全 |
| 彻底丢弃提交和改动 | `git reset --hard HEAD~1` | **破坏性** |
| 撤销已推送的提交 | `git revert <sha>` | 安全（新增反向提交） |
| 搬一个提交到当前分支 | `git cherry-pick <sha>` | 安全 |
| 找回误删的提交/分支 | `git reflog` | 后悔药 |

### 4.1 `revert` vs `reset` 的本质区别

- `reset`：**移动分支指针**，等于"这段历史没发生过"。只适合本地、未推送。
- `revert`：**新增一个反向提交**，历史完整保留。适合已推送、线上已发布。

线上出问题必须用 `revert`——因为别人已经拉过你的提交，删掉历史只会制造更多问题。

### 4.2 `reflog` 能救什么

误 `reset --hard`、误删分支、`rebase` 搞坏——只要没被 GC，`reflog` 里都有。

```bash
git reflog                  # 找到目标 SHA
git reset --hard <sha>      # 或 git branch <name> <sha>
```

---

## 5. 测试入门

### 5.1 测试金字塔

```
        /\        E2E：真启动服务，测完整链路（少）
       /  \
      /____\      集成：Controller + Pipe + Filter（中）
     /      \
    /________\    单元：纯函数、Service 逻辑（多）
```

- **单元测试**：毫秒级、无网络无数据库、失败能精确定位。
- **E2E**：秒级、依赖环境、失败只能知道"链路断了"。

倒金字塔（E2E 多、单测少）的后果：CI 跑十几分钟、随机失败、改一个字段要修 20 个测试。

### 5.2 AAA 模式

```ts
it('第二页返回第二段数据', () => {
  // Arrange
  const items = [1, 2, 3, 4, 5];
  const query = { page: 2, pageSize: 2 };

  // Act
  const result = paginate(items, query);

  // Assert
  expect(result.items).toEqual([3, 4]);
  expect(result.total).toBe(5);
});
```

### 5.3 测试命名即文档

```
✅ '页码为 0 时回退到第 1 页'
✅ '页码超出范围时返回空数组'
✅ 'pageSize 超过上限时被裁剪到 100'
❌ 'test1'
❌ 'should work'
```

### 5.4 覆盖率不是 KPI

80% 覆盖率 + 有效断言 > 100% 覆盖率 + `expect(true).toBe(true)`。

**优先测边界**：空数组、0、负数、超大值、undefined、异常分支。

### 5.5 先测什么

| 优先级 | 目标 | 理由 |
| --- | --- | --- |
| 1 | `paginate()` | 纯函数，边界密集，零依赖 |
| 2 | `AppError.retryable` | 影响重试策略的一行判断 |
| 3 | `UsersService` | 业务核心，可 mock 依赖 |
| 4 | `/api/health` e2e | 链路最短，用来验证测试基建 |
| 5 | 统一响应结构 | 契约，回归时最怕破 |

---

## 6. 落地：给项目接上 Jest

### 6.1 安装

```bash
pnpm --filter @ai-lab/api add -D jest ts-jest @types/jest supertest @types/supertest
```

- `jest`：测试框架
- `ts-jest`：让 Jest 直接跑 `.ts`（会做类型检查）
- `supertest`：e2e 里发 HTTP 请求，不用真的监听端口

### 6.2 配置 `apps/api/jest.config.js`

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
};
```

### 6.3 脚本

```json
"test": "jest",
"test:watch": "jest --watch",
"test:cov": "jest --coverage",
"test:e2e": "jest --testPathPattern=e2e"
```

### 6.4 第一个单元测试：`src/common/utils/pagination.spec.ts`

```ts
import { paginate } from './pagination';

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5];

  it('默认返回第一页', () => {
    const result = paginate(items, { page: 1, pageSize: 2 } as never);
    expect(result.items).toEqual([1, 2]);
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(3);
  });

  it('最后一页只返回剩余数据', () => {
    const result = paginate(items, { page: 3, pageSize: 2 } as never);
    expect(result.items).toEqual([5]);
  });

  it('页码超出范围返回空数组', () => {
    const result = paginate(items, { page: 99, pageSize: 2 } as never);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(5);
  });

  it('空数组不崩溃', () => {
    const result = paginate([], { page: 1, pageSize: 10 } as never);
    expect(result.items).toEqual([]);
    expect(result.totalPages).toBe(0);
  });
});
```

> 注：具体字段（`totalPages` 是否存在、超界返回空还是回退）以你仓库 `pagination.ts` 的实现为准。**测试的第一作用是把实现的行为钉死**——如果测试写不下去，说明接口设计有问题。

### 6.5 第一条 e2e：`test/health.e2e-spec.ts`

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health 返回统一成功结构', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.requestId).toBeTruthy();
  });

  it('未知路由返回 404 统一失败结构', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBeTruthy();
  });
});
```

**e2e 必须手动挂全局管道/拦截器/过滤器**——因为 main.ts 里的 `app.useGlobalPipes(...)` 在 `Test.createTestingModule` 时不会自动执行。这是新手最容易踩的坑：测试里通过、线上结构不对。

---

## 7. 自测

1. 为什么已推送的公共分支不能 `rebase`？
2. `git revert` 和 `git reset` 的本质区别？线上已发布的问题该用哪个？
3. 为什么测试金字塔是"单元多、E2E 少"？反过来会怎样？

## 8. 练习

**练习 1**：给 `paginate` 写 4 个测试，必须覆盖：默认值、最后一页、超界、空数组。

**练习 2**：跑通 `/api/health` e2e，并故意把 `ResponseInterceptor` 去掉，观察断言如何失败——体会"e2e 保护契约"。

**练习 3**：用 `git log --grep="^fix"` 统计本周修复了几次，看看能否回忆起每次的根因。

**练习 4**：在临时分支上做一次 `git reset --hard HEAD~1`，再用 `reflog` 找回来。

## 9. 今日三行

- 今天解决了什么问题：
- 为什么这样设计：
- 还有什么不确定：
