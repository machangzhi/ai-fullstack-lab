# Day 1 笔记：环境与工程初始化

> 日期：2026-11-13
> 对应计划：第 1 周 · Day 1 —— Node.js LTS、pnpm、Git、VS Code、环境变量；monorepo；前端 Vue3 + Vite + TS、后端 NestJS + TS；ESLint / Prettier / 路径别名 / .env.example

## 0. 一句话总结

Day 1 不是在"装软件"，而是在给后面 15 周打三条地基：

1. **运行时地基**：Node.js 版本与模块体系（ESM / CJS）。
2. **依赖与目录地基**：pnpm workspace，决定"代码放在哪、怎么共享、怎么单独发布"。
3. **规则地基**：TypeScript 配置、ESLint、Prettier、环境变量，决定"多人（含 AI）协作时不出错"。

---

## 1. Node.js：先搞清版本与模块体系

### 1.1 LTS 与 engines

- Node.js 版本号是**偶数 = LTS（长期支持）**，奇数 = Current（尝鲜，不建议生产）。选 LTS 是为了拿到 18～24 个月的安全补丁。
- 项目里 [package.json](../../package.json) 写了：

```json
"engines": { "node": ">=20" }
```

`engines` **只是声明，不会自动阻止安装**（pnpm 默认只警告，除非配置 `engine-strict=true`）。它的价值在于：给团队和 CI 一个明确的最低版本，避免"我这能跑你那你跑不了"。

### 1.2 ESM 与 CommonJS：两个包为什么不一样

| | `apps/api`（NestJS） | `apps/web`（Vite） |
| --- | --- | --- |
| 模块体系 | CommonJS | ESM |
| 标志 | 没写 `"type"`，默认 CJS；tsconfig `module: "commonjs"` | `"type": "module"`；tsconfig `module: "ESNext"` |
| 原因 | NestJS 依赖装饰器元数据 + `tsc` 直接编译成 CJS，`require` 语义最稳；不用处理 ESM 下相对导入必须带 `.js` 后缀的坑 | 浏览器原生支持 ESM；Vite 开发时用原生 ESM 按需加载，构建时由 Rollup 打包 |

**要记住的判断**：`import` 写在源码里两种体系都能写，差别在**编译产物怎么加载**。服务端用 CJS 是"少踩坑"的选择，前端用 ESM 是"浏览器只认这个"的选择。

---

## 2. pnpm：三个真正需要理解的机制

### 2.1 内容寻址存储（global store）

pnpm 不把包复制进每个项目的 `node_modules`，而是先存到全局 store（`pnpm store path` 可查），再用**硬链接**放进项目。

- 结果：10 个项目装同一个 React，磁盘只留一份。
- 对比 npm：npm 每个项目一份拷贝；yarn PnP 干脆不要 node_modules（兼容性差）。

### 2.2 严格的 node_modules（默认不扁平）

npm/yarn 会把依赖全部提升到顶层 `node_modules`，于是你能 `import` 一个**没在自己 package.json 里声明**的包（幽灵依赖）。

pnpm 默认只把**你声明过的依赖**放在顶层，其余藏在 `.pnpm/` 里，从物理上禁止幽灵依赖。

但本项目在 [.npmrc](../../.npmrc) 里改成了扁平：

```ini
node-linker=hoisted
virtual-store-dir-max-length=64
```

- 原因：Windows 下 pnpm 的符号链接 + 长路径常触发 `EPERM`（目录重命名失败），NestJS / Vite 的一些工具链对隔离结构也不够友好。
- 代价：**重新获得了幽灵依赖的可能**。所以后续要自觉：用到的包必须在对应 `package.json` 里声明。

### 2.3 workspace：包之间的"内部依赖"

[pnpm-workspace.yaml](../../pnpm-workspace.yaml)：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'mcp-servers/*'
```

这三行决定了"哪些子目录被当作一个包"。之后 `packages/rag` 被 `apps/api` 引用时，可以写 `"@ai-lab/rag": "workspace:*"`，pnpm 会直接链接本地目录，而不是去 npm 下载。

### 2.4 常用命令（背下来）

```bash
pnpm install                          # 安装全部 workspace 依赖
pnpm -r build                         # 所有包按依赖拓扑序依次构建
pnpm --filter @ai-lab/web dev         # 只跑 web 的 dev
pnpm --parallel --filter @ai-lab/api --filter @ai-lab/web dev   # 两个并行跑
pnpm --filter @ai-lab/web add axios    # 只给 web 装依赖
pnpm -r typecheck                      # 全仓库类型检查
```

- `-r`（recursive）：递归执行，**按拓扑排序**（被依赖的先跑）。
- `--filter`：按包名筛，是 monorepo 最常用的开关。
- `--parallel`：并行执行，不保证顺序，适合 dev 这种长期运行的进程。

---

## 3. 目录结构：apps / packages / mcp-servers 的分工

| 目录 | 角色 | 是否可独立部署 | 本周状态 |
| --- | --- | --- | --- |
| `apps/api` | 后端 HTTP 服务（NestJS） | ✅ 是 | 已实现 |
| `apps/web` | 前端页面（Vue3 + Vite） | ✅ 是 | 已实现 |
| `packages/*` | 被多个 app 复用的库（ai-core / rag / agent） | ❌ 否（被引用） | 只有 README |
| `mcp-servers/*` | 独立进程的 MCP 服务 | ✅ 是 | 只有 README |

**为什么不分三个仓库**：类型可以跨包共享（一个 `ApiResponse` 类型改一次全仓生效）、改一处联调不用发版、CI 只跑一遍。**代价**：仓库变大、权限粒度变粗，所以用"包边界"来模拟仓库边界。

---

## 4. TypeScript 配置分层

### 4.1 根配置 [tsconfig.base.json](../../tsconfig.base.json)

| 配置项 | 作用 | 为什么需要 |
| --- | --- | --- |
| `target: ES2022` | 编译目标语法 | Node 20 完整支持 ES2022，不用降级 |
| `module: commonjs` | 输出 CJS | 服务端稳，`require` 语义清晰 |
| `moduleResolution: node` | 模块解析策略 | 配合 CJS，按 node_modules 逐层查找 |
| `strict: true` | 严格模式总开关 | 一次性打开 `strictNullChecks`、`noImplicitAny` 等，是"先苦后甜"的选择 |
| `experimentalDecorators: true` | 允许 `@Decorator` 语法 | NestJS 的 `@Controller`、`@Injectable` 全靠它 |
| `emitDecoratorMetadata: true` | 编译时输出类型元数据 | **NestJS 依赖注入的命根子**：不开启，`constructor(private svc: Svc)` 无法在运行时知道参数类型，DI 直接报错 |
| `esModuleInterop: true` | 允许 `import express from 'express'` | 兼容 CJS 包的默认导出 |
| `skipLibCheck: true` | 跳过 `.d.ts` 检查 | 第三方类型定义常有冲突，跳过能大幅提速 |
| `forceConsistentCasingInFileNames` | 大小写必须一致 | Windows 不区分大小写、Linux 区分，避免"本地能跑服务器报错" |
| `resolveJsonModule` | 允许 import JSON | 读配置文件常用 |
| `sourceMap: true` | 生成 source map | 报错栈能映射回 TS 源码，调试必需 |

### 4.2 后端 [apps/api/tsconfig.json](../../apps/api/tsconfig.json)

只写"base 里没有的"：

- `outDir: ./dist`：编译产物目录。
- `rootDir: ./src`：源码根，保证 `dist/main.js` 的路径可预测。
- `types: ["node"]`：只加载 Node 类型，避免前端 DOM 类型混进来。
- `include`: 只编译 `src`。

`tsconfig.build.json` 再 `exclude` 掉 `dist` 和 `node_modules`，防止 `tsc` 把自己产出的文件再编译一遍。

### 4.3 前端 [apps/web/tsconfig.json](../../apps/web/tsconfig.json) 为什么不继承 base

前端和 Node 的编译环境本质不同：

- `module: ESNext` + `moduleResolution: bundler`：交给 Vite/Rollup 处理模块，源码里可以写无后缀导入。
- `lib: ["ES2022", "DOM", "DOM.Iterable"]`：需要浏览器 API 类型。
- `noEmit: true`：**TS 只做类型检查，不产出 JS**，真正打包是 Vite 的事。
- `isolatedModules: true`：要求每个文件能独立转译（Vite 逐文件编译的前提）。
- `useDefineForClassFields: true`：与新版 class 字段语义保持一致。
- `jsx: preserve`：保留 JSX，交给插件处理。
- `types: ["vite/client", "node"]`：拿到 `import.meta.env` 的类型。

---

## 5. 路径别名：为什么必须配两处

前端 [apps/web/tsconfig.json](../../apps/web/tsconfig.json)：

```json
"paths": { "@/*": ["src/*"] }
```

前端 [vite.config.ts](../../apps/web/vite.config.ts)：

```ts
alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
```

分工：

- `tsconfig.paths` 只让 **TypeScript 类型检查**认识 `@/`，它不改变运行/打包结果。
- `vite.alias` 才真正让 **Vite 在解析模块时**把 `@/` 替换成绝对路径。

**只配一处会怎样**：只配 tsconfig → 编辑器不报错，但 `vite build` 找不到模块；只配 vite → 能跑，但编辑器满屏红线。这就是"双配置原则"。

`fileURLToPath(new URL('./src', import.meta.url))` 是 ESM 下获取当前文件所在目录的标准写法（ESM 没有 `__dirname`）。

> 后端目前只有 `baseUrl: "."`，没有 `paths`。等包变多、目录变深时值得补一份，属于 Day 1 的"可改进项"。

---

## 6. 环境变量：三层与一条红线

### 6.1 三层

1. `.env.example` —— **契约**，进 Git，只写键和示例值，说明每个变量干什么。
2. `.env` / `.env.local` —— **私货**，不进 Git（[.gitignore](../../.gitignore) 里已有 `.env`、`.env.local`、`.env.*.local`）。
3. 运行时读取 —— 后端用 `ConfigService`，前端用 `import.meta.env`。

### 6.2 后端变量（[apps/api/.env.example](../../apps/api/.env.example)）

```
PORT=9527
APP_NAME=ai-fullstack-lab-api
APP_ENV=development
APP_VERSION=0.1.0
CORS_ORIGIN=http://localhost:5173
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=
MODEL_NAME=
MODEL_API_KEY=
```

`CORS_ORIGIN` 设计成**逗号分隔的列表**，是为了以后多域名（本地 + 测试服 + 正式域名）不用改代码。

### 6.3 前端变量与红线

[apps/web/.env.example](../../apps/web/.env.example)：

```
VITE_API_BASE_URL=/api
```

- 只有 `VITE_` 前缀的变量会被 Vite **打进前端产物**，也就是**任何人打开浏览器都能看到**。
- 所以：**API Key、数据库密码永远不能放前端**，哪怕变量名再隐蔽。模型调用必须走后端（这也是为什么 `MODEL_API_KEY` 只出现在后端 `.env.example`）。
- `/api` 在开发时走 Vite 代理（[vite.config.ts](../../apps/web/vite.config.ts) 的 `server.proxy`），生产时走 Nginx 前缀转发。

---

## 7. 规范三件套：职责别混

| 工具 | 管什么 | 配置 |
| --- | --- | --- |
| EditorConfig | 编辑器无关的基础格式（缩进、换行符、编码） | [.editorconfig](../../.editorconfig) |
| Prettier | **纯格式**（单引号、分号、行宽、尾逗号） | [.prettierrc](../../.prettierrc) |
| ESLint | **代码质量**（未使用变量、隐式 any、Vue 规则） | `apps/*/eslint.config.*` |

关键认知：**Prettier 不管对错，ESLint 不管好看**。两者职责不重叠，不要用 ESLint 的 format 规则去替代 Prettier。

### 7.1 ESLint 的 flat config

ESLint 9+ 用 `eslint.config.js` 数组式配置，数组每一项是一个"配置对象"，**后面的覆盖前面的**：

```js
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] } },
];
```

前端额外要点：

- `...pluginVue.configs['flat/recommended']`：Vue 规则集。
- `globals.browser`：声明 `window`、`document` 等浏览器全局，否则会被判为未定义。
- `.vue` 文件需要两层 parser：`vue-eslint-parser` 拆 `<template>`/`<script>`，`tseslint.parser` 解析 `<script lang="ts">`。

---

## 8. 启动链路：`pnpm dev` 到底发生了什么

根 [package.json](../../package.json)：

```
pnpm dev
  └─ pnpm --parallel --filter @ai-lab/api --filter @ai-lab/web dev
       ├─ @ai-lab/web  →  vite                    （5173，HMR）
       └─ @ai-lab/api  →  node scripts/dev.mjs    （tsc --watch + node --watch dist/main.js）
```

后端为什么不直接用 `tsx` / `esbuild` 跑 TS：它们走的是**编译时擦除**，会丢掉 `emitDecoratorMetadata` 产生的类型元数据，NestJS 的 DI 就废了。所以选择"先 `tsc` 出 JS，再 `node` 跑 JS"——慢一点，但语义正确。这正是 Day 4 学依赖注入时要回头看的伏笔。

---

## 9. 今日自测（先别翻答案）

1. 如果把 `emitDecoratorMetadata` 改成 `false`，NestJS 会在什么时候、报什么错？
2. 前端 `@/` 别名只配 tsconfig 不配 vite，`pnpm dev` 会怎样？反过来呢？
3. 为什么 `MODEL_API_KEY` 可以写在 `apps/api/.env`，却绝不能写 `apps/web/.env`？

## 10. 练习

**练习 1（filter）**：只跑前端类型检查，不构建、不启动。

```bash
pnpm --filter @ai-lab/web typecheck
```

**练习 2（strict）**：在 `apps/web/tsconfig.json` 把 `"strict": true` 改成 `false`，再跑一次 typecheck，观察结果变化，然后**改回 true**。想一想：strict 关掉后，哪一类 bug 会更容易溜进生产？

**练习 3（双配置原则）**：在 `apps/web/src/` 下新建一个 `utils/format.ts`，导出一个函数；在 `HomeView.vue` 里分别用 `@/utils/format` 和 `../../utils/format` 各 import 一次，感受两种写法的取舍。验证完可删除。

**练习 4（环境变量边界）**：在 `apps/web/.env.local` 里加一行 `VITE_TEST_FLAG=hello`，在 `HomeView.vue` 里打印 `import.meta.env.VITE_TEST_FLAG`，运行 `pnpm dev` 看浏览器控制台。然后把变量改成 `TEST_FLAG=hello`（去掉前缀），重启再看——它消失了。这就是"只有 VITE_ 会注入前端"的证据。

## 11. 今日三行

- 今天解决了什么问题：
- 为什么这样设计：
- 还有什么不确定：
