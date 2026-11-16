# 第 2 周补课：会话/消息接口与文件上传

> 补齐 16 周计划第 2 周 Day 1（SQL 练习）、Day 5（文件上传）以及 Day 6 交付要求中缺失的部分。

---

## 一、补齐了什么

| 计划要求 | 补课内容 |
|---|---|
| D1「三表 CRUD、分页、排序 SQL」 | 用 `EXPLAIN ANALYZE` 验证 Prisma 生成的 SQL 是否命中索引 |
| D6「会话管理、消息持久化」 | `/api/conversations` 全套接口（5 个） |
| D5「文件上传与安全」 | `POST /api/files/upload`，MIME 白名单 + 大小限制 + 文件名安全 |

---

## 二、会话与消息接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/conversations` | 创建会话（标题可选） |
| GET | `/api/conversations` | 我的会话列表（按 updatedAt 倒序） |
| GET | `/api/conversations/:id` | 详情 |
| GET | `/api/conversations/:id/messages` | 消息分页（升序，默认 50/页） |
| POST | `/api/conversations/:id/messages` | 发消息 |

### 三个关键设计

**1. 归属校验 = 防 IDOR**

```ts
findFirst({ where: { id: conversationId, userId } })
```

只按 `id` 查，攻击者猜到别人的会话 id 就能读写——这叫 IDOR（Insecure Direct Object Reference）。
把 `userId` 写进 where，让"存在"和"属于你"由同一条查询回答。

并且：**别人的会话与不存在的会话返回同一个 404**，不泄露"这个 id 存在"。

**2. role 由服务端固定**

```ts
role: MessageRole.USER,   // 绝不接受客户端传入
```

允许客户端指定 `role` 就等于允许伪造 `assistant` 消息：既能污染上下文，也能做 prompt 注入。

**3. 发消息必须用事务**

```ts
$transaction([
  message.create(...),
  conversation.update({ data: { updatedAt: new Date() } }),
])
```

少了第二步，消息写进去了但会话不会在列表里冒泡到顶部。用户会以为"消息没发出去"。

---

## 三、用 EXPLAIN 验证索引（D1 的 SQL 练习）

### 会话列表查询

```sql
SELECT id, title FROM conversations
WHERE "userId" = '...' ORDER BY "updatedAt" DESC LIMIT 20;
```

```
Bitmap Index Scan on "conversations_userId_updatedAt_idx"
  Index Cond: ("userId" = '...')
Execution Time: 0.082 ms
```

✅ 命中复合索引 `(userId, updatedAt)`。顺序不能反：`userId` 等值在前、`updatedAt` 排序在后，索引才能同时承担过滤和排序。

### 消息查询（当前数据量极小）

```
Seq Scan on messages  (rows=2)
Sort Method: quicksort  Memory: 25kB
```

⚠️ 走的是**顺序扫描**。这不是索引没用，而是表里只有 2 行——优化器判断全表扫比走索引更便宜。
等数据到几千行，`messages_conversationId_createdAt_idx` 才会被用上。

**这是今天最重要的一课：不要看到 `Seq Scan` 就加索引。先看行数、再看 `EXPLAIN ANALYZE` 的实际耗时。**

---

## 四、文件上传的四道防线

```ts
// 1. MIME 白名单（只列允许的，不列禁止的）
const ALLOWED_TYPES = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'],
  ['application/pdf', '.pdf'], ['text/plain', '.txt'], ['text/markdown', '.md'],
]);

// 2. 大小限制：超出直接 413，不先读进内存
limits: { fileSize: 5 * 1024 * 1024, files: 1 }

// 3. 文件名由服务端生成：扩展名来自白名单映射
filename: (_req, file, cb) => cb(null, `${randomUUID()}${ALLOWED_TYPES.get(file.mimetype)}`)

// 4. 登录校验
@UseGuards(JwtAuthGuard)
```

### 为什么文件名绝不能来自客户端

攻击者提交 `../../../etc/passwd`：

- 若直接拼接路径 → **路径穿越**，可以覆盖系统文件；
- 若信任扩展名 → `shell.php.jpg` 这类双扩展名可以绕过只检查后缀的逻辑。

本项目实测：文件名 `../../../etc/passwd` 上传后，落盘名是随机 UUID + `.txt`（扩展名由 MIME 决定）。

---

## 五、实测结果（10 项）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 创建会话 | 201，标题正确 |
| 2 | 发消息 | 201，`role=USER` |
| 3 | 发第二条 | 201 |
| 4 | 拉消息列表 | 200 `total=2`，按时间升序 |
| 5 | 我的会话列表 | 200 `messageCount=2` |
| 6 | **他人访问我的会话** | **404**（不泄露存在性） |
| 7 | 无 Token | 401 `UNAUTHORIZED` |
| 8 | 上传 txt | 201，`.txt`，12 字节 |
| 9 | 上传 exe（MIME 伪造） | **400** `不支持的文件类型` |
| 10 | 路径穿越文件名 | 201，落盘名随机 UUID，扩展名仍为 `.txt` |

---

## 六、技术债

| 项 | 说明 |
|---|---|
| MIME 可伪造 | 客户端声明的 MIME 不可信，严格场景要读文件头（magic number） |
| 本地磁盘存储 | 多实例/容器重启会丢文件，生产应用对象存储（OSS/S3） |
| 无文件访问鉴权 | 目前只返回元数据，未提供下载接口；做下载时同样要校验归属 |
| 无病毒扫描 | 上传 PDF/图片也应做一次扫描（如 ClamAV） |
| 无配额 | 单用户可无限上传，需按用户统计容量 |

---

## 七、自测题

1. `findFirst({ where: { id } })` 与 `findFirst({ where: { id, userId } })`，攻击者用前者能做什么？
2. 为什么发消息要同时更新 `conversation.updatedAt`？不更新会有什么用户体验问题？
3. `EXPLAIN` 里看到 `Seq Scan` 就一定该加索引吗？判断依据是什么？

---

## 八、今日三行

- 记住了什么：
- 还没搞懂的：
- 明天要先补的：
