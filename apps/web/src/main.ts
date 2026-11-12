/**
 * 文件作用：前端应用入口。
 *
 * 关键概念：
 * 1. createApp(App) —— 创建 Vue 应用实例，App 是根组件。
 * 2. .use(router) —— 注册 Vue Router 插件，让 <RouterView> 和 <RouterLink> 可用。
 * 3. .mount('#app') —— 把应用挂载到 index.html 中 id="app" 的 DOM 节点上。
 * 4. import './style.css' —— 引入全局样式（设计系统变量），Vite 会处理 CSS 导入。
 * 5. 第 2 周会在这里再加 .use(pinia) 注册状态管理，以及 Element Plus 等 UI 库。
 */

import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';

// 创建应用 → 注册路由 → 挂载到 DOM。链式调用是 Vue 3 的标准写法。
createApp(App).use(router).mount('#app');
