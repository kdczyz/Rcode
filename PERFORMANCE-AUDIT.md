# Rcode Desktop Client - 性能审计报告

> 审计时间: 2025-07-21 | 范围: 电脑客户端版 (Electron + React/Vite + Node Agent)

## 基线数据

| 指标 | 当前值 |
|------|--------|
| 前端 JS bundle | 369 KB (gzip 114 KB) |
| 前端 CSS bundle | 196 KB (gzip 35 KB) |
| 前端构建耗时 | 938ms (1587 modules) |
| 服务端测试 | 63/63 pass, 916ms |
| TypeScript 编译 | 有 1 个类型错误 (delegate_agents 缺失) |
| App.tsx 行数 | **5,907 行** |
| ChatComposer.tsx 行数 | 742 行 |
| 主进程 main.cjs 行数 | 1,198 行 |
| Agent 主循环 agent.ts 行数 | 654 行 |

---

## 发现列表 (按严重度排序)

### 🔴 P0: App.tsx 5907 行巨型单组件 + 零 memo 化

**现状**: 整个桌面端 UI 几乎全部写在一个 `App()` 函数组件中，包含 **30+ 个 useState**，但:
- **0 个** `React.memo()` 包裹的子组件
- **0 个** `useCallback()` 
- **0 个** `useRef()` 用于缓存回调
- 仅提取了 2 个内部函数组件 (`MessageCodeBlock`, `MessageLink`)

**影响**: 
- 任何一次 `setState` 都会触发整个 5907 行组件树的 re-render
- 结合 P1 的每秒 timerTick，意味着 **整个 UI 每秒至少完整 re-render 一次**
- 在长对话（50+ 消息 + 工具调用）场景下，每次 re-render 的 React reconciliation 开销可观

**修复建议**:
1. 将 Settings、Chat 会话列表、消息列表、工具调用面板拆分为独立组件并用 `React.memo` 包裹
2. 对频繁传递的回调（如消息操作、滚动处理）使用 `useCallback`
3. 对消息列表的 `visibleMessages` 渲染用 `useMemo` + virtualization (如 `@tanstack/react-virtual`)

---

### 🔴 P1: 每秒 timerTick 强制全组件 re-render

**现状** (App.tsx:2168):
```js
const intervalId = window.setInterval(() => setTimerTick(Date.now()), 1000);
```
`timerTick` 被 3 处引用:
- 行 1785: 计算任务计时器 `activeTaskElapsedMs`
- 行 5305: 显示消息耗时
- 行 5310: 显示消息耗时

**影响**: 每秒触发一次 `setTimerTick(Date.now())` → 每秒一次完整 App re-render（因为 timerTick 是 App 的 useState）

**修复建议**:
1. 将计时器逻辑下沉到一个独立的 `<TaskTimer>` 组件内部，该组件自己管理 `setInterval`
2. 或将 `timerTick` 改为 `useRef` + `requestAnimationFrame`，只在 UI 需要更新时才 `setState`
3. 预期效果: 消除每秒全组件 re-render

---

### 🟡 P2: 1.5 秒轮询 managed processes（无条件）

**现状** (App.tsx:2026):
```js
const intervalId = window.setInterval(() => void pollManagedProcesses(), 1_500);
```
这个轮询在应用启动时就注册，**无论是否有正在运行的托管进程**。

**影响**: 即使没有活跃进程，也每 1.5 秒发一次 `GET /api/processes` 请求。一天累计约 57,600 次无用请求。

**修复建议**:
1. 只在 `isResponseRunning` 为 true 或有已知活跃进程时才开始轮询
2. 进程全部结束后停止轮询
3. 可选: 服务端改为 SSE/WebSocket 推送，避免客户端轮询

---

### 🟡 P3: 内存中的会话缓存无驱逐策略

**现状** (agent.ts:30):
```ts
const projectConversations = new Map<string, Map<string, Conversation>>();
```
这个 Map 按项目路径 → 会话 ID 存储完整的 `messages: AgentMessage[]` 数组。代码中 **没有任何 `.delete()` 或 `.clear()` 调用**（经 grep 验证）。

**影响**: 
- 每次对话的完整消息历史（含工具调用的大量输出）都驻留在内存中
- 长时间使用后，如果打开了多个项目/会话，内存会持续增长
- 结合 contextManager 的 compaction，发送给 AI 的消息会裁剪，但本地缓存不裁剪

**修复建议**:
1. 为每个会话设置消息上限（如保留最近 200 条，旧的只存数据库）
2. 添加 LRU 驱逐策略：超过 N 个会话或总消息超过阈值时，将最久未访问的会话从内存中移除
3. 会话切换时 lazy load（从 DB 加载，不预加载所有会话）

---

### 🟡 P4: SQLite 缺少关键查询索引

**现状**: 只创建了 2 个索引:
- `memories(project_path, updated_at DESC)` ✅
- `learning_records(project_path, dedupe_key)` ✅

**缺失索引**:
| 表 | 高频查询模式 | 影响 |
|----|------------|------|
| `messages` | `WHERE conversation_id = ? ORDER BY created_at` | 加载会话消息列表 |
| `approvals` | `WHERE conversation_id = ? ORDER BY created_at` | 加载审批记录 |
| `audit_events` | `WHERE conversation_id = ?` / `WHERE created_at > ?` | 审计查询 |
| `conversations` | `WHERE project_path = ? ORDER BY updated_at DESC` | 会话列表 |
| `agent_usage_events` | `WHERE project_path = ? AND created_at > ?` | 用量统计 |
| `artifacts` | `WHERE conversation_id = ?` | 加载工件 |

**修复建议**: 在 `migrateDatabase()` 中为上述查询模式添加索引。会话消息查询是最高优先级（每次打开会话都触发）。

---

### 🟢 P5: Settings 页面批量请求 7+ 个 API

**现状** (App.tsx:3412):
```js
const [mcpData, usageData, aiData, skillsData, learningData, memoryData, memorySettingsData] = await Promise.all([
  fetch(`${API_BASE}/api/mcp/servers`, ...),
  fetch(`${API_BASE}/api/usage`, ...),
  fetch(`${API_BASE}/api/ai/providers`, ...),
  fetch(`${API_BASE}/api/skills`, ...),
  fetch(`${API_BASE}/api/learning`, ...),
  fetch(`${API_BASE}/api/memory`, ...),
  fetch(`${API_BASE}/api/memory/settings`, ...),
]);
```

**影响**: 虽然用了 `Promise.all` 并行化，但 7 个并发请求在本地 HTTP 上仍有一定开销。且切换到 Settings 面板时会重新请求全部数据。

**修复建议**:
1. 缓存 Settings 数据，仅在数据变更后 invalidate
2. 或提供一个 `/api/settings/bundle` 端点，一次返回所有 settings 相关数据
3. 首次加载后，后续切换不再重新请求

---

### 🟢 P6: Electron 主进程 remote 状态管理（已做得不错）

**现状**: 经审查，remote 状态管理的三个核心数据结构都有合理的边界控制:
- `receivedRemoteCommandIds`: 超过 200 个时删除最早的 ✅
- `remoteReliableOutbox`: 超过 100 个时截断 ✅  
- `remoteCommandQueue`: 通过 splice 移除已完成命令 ✅
- heartbeat timer: 在断开时 clearInterval ✅

**结论**: 无明显内存泄漏风险。无需修改。

---

### 🟢 P7: SQLite 使用同步 DatabaseSync API

**现状**: `server/storage/database.ts` 使用 Node.js 实验性 `DatabaseSync` API，所有数据库操作同步执行，阻塞事件循环。

**影响**: 在当前单用户桌面端场景下，数据库操作量小（毫秒级），影响不大。但如果未来支持并发请求或大量审计数据，可能成为瓶颈。

**建议**: 暂不修改，但建议在代码注释中标记为技术债务，未来迁移到 `better-sqlite3` 或异步驱动。

---

## 优化优先级路线图

### 第一阶段: 消除每秒 re-render (预计提升最大)
1. 将 timerTick 逻辑下沉到独立组件
2. 将 Settings 面板拆分为独立组件 + React.memo
3. 将消息列表拆分为独立组件 + React.memo + 虚拟滚动

### 第二阶段: 减少无用计算和网络请求
4. 条件化 managed processes 轮询
5. 添加缺失的 SQLite 索引
6. 缓存 Settings 页面数据

### 第三阶段: 内存优化
7. 会话缓存添加 LRU 驱逐
8. 消息历史分页加载（长对话场景）

---

## 已做得好的方面

1. **Vite 构建速度快**: 938ms 构建 1587 个模块
2. **SQLite WAL 模式已启用**: 写入不阻塞读取
3. **Electron remote 状态有上限**: 不会无限增长
4. **服务端测试覆盖良好**: 63 个测试全部通过
5. **Context compaction 已实现**: 会话过长时自动裁剪
6. **权限系统健全**: 工具调用有风险评估和审批流程
7. **前后端分离清晰**: Agent 服务独立运行，Electron 仅做 IPC 桥接
