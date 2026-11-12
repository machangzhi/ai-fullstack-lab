/**
 * 文件作用：Vue Router 路由配置。
 *
 * 关键概念：
 * 1. createRouter —— 创建路由实例，需要 history 模式和 routes 数组。
 * 2. createWebHistory() —— HTML5 History 模式，URL 干净（没有 #），
 *    但要求服务器对所有路由都返回 index.html（否则刷新 404）。
 *    开发时 Vite dev server 自动处理，生产部署时需要 Nginx 配置 try_files。
 *    （另一种是 createWebHashHistory，URL 带 #，不需要服务器配置，但不美观。）
 * 3. routes —— 路由表，每条记录 path/name/component。
 *    第 1 周只有首页，第 2 周会加 /login、/register、/users 等路由。
 * 4. 后续会加路由守卫（beforeEach）做登录态校验。
 */

import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
  ],
});

export default router;
