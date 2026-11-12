<!--
  文件作用：根组件 App.vue。
  关键概念：
  1. <script setup> —— Vue 3 组合式 API 的语法糖，顶层变量/函数自动暴露给模板，
     不用写 export default { setup() {...} }。本文件目前 script 为空，因为布局是静态的。
  2. app-shell / app-header / app-main / app-footer —— 经典的三段式布局容器，
     样式定义在全局 style.css 中。
  3. <RouterLink to="/"> —— 路由链接组件，点击不刷新页面，由 Vue Router 接管。
  4. <RouterView /> —— 路由出口，当前路由匹配的组件渲染在这里。
  5. API 文档链接用原生 <a> + target="_blank"，因为是外链（Swagger 在后端 9527 端口）。
-->

<script setup lang="ts">
  // 第 1 周根组件没有脚本逻辑，纯布局。
  // 第 2 周会在这里加全局状态（如当前登录用户）和路由守卫相关逻辑。
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
          href="http://localhost:9527/docs"
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
