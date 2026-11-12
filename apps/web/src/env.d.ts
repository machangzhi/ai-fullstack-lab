/// <reference types="vite/client" />

/**
 * 文件作用：Vite 环境变量类型声明。
 *
 * 关键概念：
 * 1. Vite 通过 import.meta.env 暴露环境变量，但默认类型是 Record<string, string>，
 *    无法获得具体字段的类型提示。
 * 2. 通过声明 ImportMetaEnv 接口，可以让 import.meta.env.VITE_API_BASE_URL
 *    获得类型提示和自动补全。
 * 3. 只有以 VITE_ 开头的环境变量才会暴露给前端（安全机制，防止把服务端密钥泄露到前端包）。
 *    其他变量（如 DATABASE_URL）只在 Node 端可用。
 * 4. 这个文件需要被 tsconfig.json 的 include 包含（已配置 src 目录下所有 .d.ts 文件）。
 * 注意：上方的 /// <reference> 指令必须放在文件最顶部，否则 vue-tsc 解析会报错。
 */

interface ImportMetaEnv {
  // 前端 API 基础地址，默认 /api（开发时走 Vite 代理）。
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
