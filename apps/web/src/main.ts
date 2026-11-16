/**
 * 文件作用：前端应用入口。
 *
 * 关键概念：
 * 1. createApp(App) —— 创建 Vue 应用实例，App 是根组件。
 * 2. .use(pinia) 必须先于 router：路由守卫里要用 store 判断登录态，
 *    如果 pinia 还没注册，store 无法初始化。
 * 3. .use(router) —— 注册 Vue Router 插件，让 <RouterView> 和 <RouterLink> 可用。
 * 4. .mount('#app') —— 把应用挂载到 index.html 中 id="app" 的 DOM 节点上。
 * 5. 启动时调用 restoreSession()：页面刷新后 access token 在内存里已丢失，
 *    需要用 localStorage 里的 refresh token 恢复登录态（失败则静默忽略）。
 */

import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { useAuthStore } from './stores/auth';
import './style.css';

const app = createApp(App);

// 顺序不能反：pinia 先注册，router 守卫里才能拿到 store。
app.use(createPinia());
app.use(router);

// 挂载前先尝试恢复会话（await 保证首屏渲染时已知道登录状态）。
useAuthStore()
  .restoreSession()
  .finally(() => app.mount('#app'));
