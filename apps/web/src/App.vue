<!--
  文件作用：根组件 App.vue。
  关键概念：
  1. <script setup> —— Vue 3 组合式 API 的语法糖，顶层变量/函数自动暴露给模板，
     不用写 export default { setup() {...} }。本文件目前 script 为空，因为布局是静态的。
  2. app-shell / app-header / app-main / app-footer —— 经典的三段式布局容器，
     样式定义在全局 style.css 中。
  3. <RouterLink to="/"> —— 路由链接组件，点击不刷新页面，由 Vue Router 接管。
  4. <RouterView /> —— 路由出口，当前路由匹配的组件渲染在这里。
  5. API 文档链接用原生 <a> + target="_blank"，用相对路径 /docs，
     部署到任意域名都能正确跳转到当前域名下的 Swagger 文档。
-->

<script setup lang="ts">
  // Swagger 文档地址：基于 Vite base 路径拼接，适配子路径部署。
  // - 开发环境 base='/'  → /docs
  // - 生产部署 base='/lab/' → /lab/docs
  const swaggerUrl = `${import.meta.env.BASE_URL}docs`;
</script>

<template>
  <div class="app-shell">
    <!-- 顶部品牌栏：Logo + 标题 + 导航 -->
    <header class="app-header">
      <RouterLink
        class="brand"
        to="/"
      >
        <span class="brand-mark">AI</span>
        <span class="brand-text">
          <strong>ai-fullstack-lab</strong>
          <small>16 周 AI 应用全栈开发</small>
        </span>
      </RouterLink>
      <nav class="app-nav">
        <a
          :href="swaggerUrl"
          target="_blank"
          rel="noreferrer"
        >API 文档</a>
      </nav>
    </header>

    <!-- 主内容区：路由匹配的组件渲染在这里 -->
    <main class="app-main">
      <RouterView />
    </main>

    <!-- 页脚：显示当前周和技术栈 -->
    <footer class="app-footer">
      <span>第 1 周 · 工程环境与全栈骨架</span>
      <span>Vue3 · NestJS · TypeScript</span>
    </footer>
  </div>
</template>
