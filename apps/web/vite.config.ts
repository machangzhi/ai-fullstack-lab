/**
 * 文件作用：Vite 构建配置。
 *
 * 关键概念：
 * 1. plugins: [vue()] —— 启用 Vue 单文件组件（.vue）的编译支持。
 * 2. resolve.alias['@'] —— 把 @ 映射到 src 目录，import 时可以写 @/xxx 而不是 ../../xxx。
 *    fileURLToPath + import.meta.url 是 ESM 下获取当前文件目录的标准写法。
 * 3. server.port —— 开发服务器端口 5173（Vite 默认端口）。
 * 4. server.proxy['/api'] —— 开发代理：把前端发出的 /api/xxx 请求转发到后端
 *    http://localhost:3000，避免跨域问题（开发时前后端端口不同）。
 *    changeOrigin:true 表示修改请求头中的 Host 为目标地址。
 * 5. 生产环境没有 dev server，前端通过 Nginx 或同源部署访问后端，不需要这个代理。
 */

import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // @ → src 目录
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 把 /api 开头的请求代理到后端，开发时避免跨域。
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
