/**
 * 文件作用：Vue Router 路由配置 + 登录态守卫。
 *
 * 关键概念：
 * 1. createWebHistory(import.meta.env.BASE_URL)：History 模式，
 *    部署在子路径 /lab/ 时也能正确匹配路由（null 需要 Nginx 的 try_files 配合）。
 * 2. 路由懒加载：component: () => import('...') 让 Vite 把该页单独打包，
 *    首屏只加载当前路由需要的代码。
 * 3. meta.requiresAuth：把"需要登录"声明在路由上，
 *    守卫统一处理，而不是每个页面自己判断。
 * 4. 守卫里不 import store 到顶层会造成"pinia 尚未安装"的问题——
 *    所以把 useAuthStore() 写在守卫函数内部（调用时才执行）。
 */

import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/login',
      name: 'login',
      // 懒加载：登录页单独分包，未登录用户不必下载首页体积。
      component: () => import('@/views/LoginView.vue'),
      // 已登录用户访问登录页时，直接送回首页。
      meta: { guestOnly: true },
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('@/views/UsersView.vue'),
      // 需要登录才能访问，具体权限（admin）由后端 403 兜底。
      meta: { requiresAuth: true },
    },
  ],
});

// 全局前置守卫：在进入每个路由前执行。
router.beforeEach((to) => {
  const auth = useAuthStore();

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    // 记住原本要去的地址，登录成功后跳回去。
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (to.meta.guestOnly && auth.isAuthenticated) {
    return { name: 'home' };
  }

  return true;
});

export default router;
