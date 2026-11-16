# 第 2 周 Day 6 笔记：前端登录页 + Pinia + Axios 拦截器

> 目标：让 Token 的生命周期在前端自动化，业务组件完全不用关心"该带什么头、过期了怎么办"。

---

## 一、整条链路

```
登录 ──▶ 存 token ──▶ 每个请求自动带 Authorization
                          │
                          ├─ 200 → 正常
                          ├─ 401 → 自动刷新 → 重放原请求（用户无感）
                          └─ 刷新失败 → 清状态 → 跳登录页
```

业务组件只写 `apiGet('/users')`，不写任何鉴权代码 —— 这才是"基础设施"该有的样子。

---

## 二、Token 存哪里：一个必须讲清的取舍

| 位置 | XSS 风险 | 刷新页面是否保留 | 本项目选择 |
|---|---|---|---|
| 内存（变量） | 低（脚本能读但要注入执行） | ❌ 丢失 | **access token** |
| localStorage | 高（任意脚本可读） | ✅ | **refresh token** |
| HttpOnly Cookie | 最低（JS 读不到） | ✅ | 后续升级方案 |

结论：**access 放内存，refresh 放 localStorage**。这是"可用性 vs 安全性"的折中。更安全的做法是 refresh 走 HttpOnly Cookie + SameSite=Strict，但需要处理 CSRF 与跨域，留作技术债。

---

## 三、Pinia store 的设计

```ts
const accessToken = ref<string | null>(null);          // 内存
const refreshToken = ref(localStorage.getItem(KEY));   // 持久化
const isAuthenticated = computed(() => Boolean(accessToken.value));
```

为什么不用 `accessToken !== null` 判断登录态？因为它是响应式的 —— 组件里用 `auth.isAuthenticated` 会自动更新，不需要手动 watch。

### 循环依赖怎么破

```
client.ts 需要 token  ──▶  想 import store
store.ts  需要发请求  ──▶  想 import client
```

解法：**client 定义钩子接口，store 注册实现**。

```ts
// client.ts
export function setAuthHandlers({ getAccessToken, refreshAccessToken, onSessionExpired }) {}

// store.ts（初始化时执行一次）
setAuthHandlers({ getAccessToken: () => accessToken.value, ... });
```

client 永远不知道 Pinia 的存在，依赖方向变成单向。

---

## 四、401 自动刷新：三个细节决定成败

### 1. 单飞（single-flight）

10 个请求同时 401，如果各自去刷新：
- 第一个刷新成功，refresh token 被轮换；
- 其余 9 个拿着**旧** refresh token 去刷新 → 全部 401 → 用户被踢下线。

所以要用一个共享 Promise：

```ts
let refreshPromise: Promise<string | null> | null = null;
function refreshOnce() {
  refreshPromise ??= handlers.refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
```

### 2. 只重试一次

请求上打标记 `_retried`，避免"刷新成功但新 token 仍被拒"时无限循环。

### 3. 排除登录/刷新接口本身

`/auth/login` 返回 401（密码错误）时**不应该**触发刷新，否则错误密码也会走一遍刷新逻辑，还可能把用户的会话状态搞乱。

---

## 五、路由守卫的两个方向

```ts
if (to.meta.requiresAuth && !auth.isAuthenticated) {
  return { name: 'login', query: { redirect: to.fullPath } };
}
if (to.meta.guestOnly && auth.isAuthenticated) {
  return { name: 'home' };
}
```

- `requiresAuth`：未登录 → 跳登录页，**并记住原地址**（`?redirect=/users`），登录后自动跳回。
- `guestOnly`：已登录用户访问 `/login` → 送回首页，避免"登录了还在登录页"。

守卫里 `useAuthStore()` 必须写在函数内部，不能写在模块顶层：模块顶层执行时 Pinia 还没安装，会直接报错。

---

## 六、页面刷新后的会话恢复

`main.ts` 在 mount 前调用：

```ts
useAuthStore().restoreSession().finally(() => app.mount('#app'));
```

流程：localStorage 里有 refresh token → 换新 access → 拉 `/auth/me` → 恢复用户信息。
`finally` 保证即使恢复失败也正常渲染（用户看到的是未登录状态，而不是白屏）。

---

## 七、实测

### 构建

```
✓ 95 modules transformed
dist/assets/LoginView-BdjFRzk6.js    2.04 kB
dist/assets/UsersView-Du6UP0vG.js    1.54 kB
dist/assets/index-BFhoYv8M.js      165.11 kB
```

登录页、用户页**各自独立分包**（懒加载生效），首屏不下载它们。

### 踩坑

1. **SFC 顶部不能放 `/** */` 注释**：`.vue` 文件最外层只能是 `<template>` / `<script>` / `<style>`，注释写在最外层会被当作模板文本，报 `TS1005: ';' expected`。文件说明要放进 `<script setup>` 里。
2. **axios 1.21 的类型签名变了**：`http.get<T>()` 的返回类型不是 `Promise<T>`，需要 `as unknown as` 中转（运行期由拦截器保证）。
3. **Pinia 必须在 router 之前注册**：守卫要用 store。

---

## 八、技术债

| 项 | 说明 |
|---|---|
| refresh token 存 localStorage | 有 XSS 风险，后续改 HttpOnly Cookie |
| 无 UI 组件库 | 当前是手写样式，第 3 周接入 Element Plus 提升效率 |
| 无表单校验库 | 现在依赖原生 required/minlength，复杂表单需要 zod / vee-validate |

---

## 九、自测题

1. 为什么 access token 不存 localStorage，而 refresh token 要存？
2. 没有"单飞刷新"会出什么问题？请描述并发 10 个请求时的具体过程。
3. 为什么 `/auth/login` 的 401 不能触发自动刷新？

---

## 十、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
