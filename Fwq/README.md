# Rcode Remote Server

Rcode 安卓端与电脑 Agent 的 Cloudflare 服务端。HTTP API 运行在 Workers，账号、会话、设备和任务保存在 D1，每个账号由独立 Durable Object 协调实时 WebSocket 连接。

## 已部署环境

- API：`https://rcode-remote-server.kdczyz0728-994.workers.dev`
- 健康检查：`GET /health`
- D1：`rcode-remote-db`（APAC）
- Durable Object：`RemoteRoom`

安卓端使用：

```env
VITE_AUTH_API_URL=https://rcode-remote-server.kdczyz0728-994.workers.dev
```

## HTTP API

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/auth/logout`
- `POST /v1/remote/ticket`
- `GET /v1/remote/connect?ticket=...`（WebSocket Upgrade）

除注册和登录外均使用 `Authorization: Bearer <token>`。会话有效期 30 天；远程 ticket 为 60 秒有效的一次性凭证。

控制端申请 ticket：

```json
{ "role": "controller" }
```

电脑 Agent 申请 ticket：

```json
{
  "role": "agent",
  "device": {
    "id": "device-id",
    "name": "MacBook Pro",
    "platform": "darwin",
    "appVersion": "1.0.0",
    "projectName": "Rcode",
    "ready": true
  }
}
```

## WebSocket 协议

控制端发送：

- `ping`
- `command.create`

Agent 发送：

- `ping`
- `device.announce`
- `command.updated`
- `command.event`

服务端发送：

- `remote.ready` / `remote.snapshot`
- `command.accepted` / `command.updated`
- `command.execute`（发给目标 Agent）
- `command.event`
- `remote.error`

权限隔离在服务端执行：控制端不能伪造 Agent 状态，Agent 只能更新自身设备的任务；每个用户映射到独立 Durable Object。

## 本地开发

```bash
npm install
npm run db:migrate:local
npm run dev
```

验证：

```bash
npm run check
npm test
npx wrangler deploy --dry-run
```

## 部署

```bash
npx wrangler whoami
npm run db:migrate:remote
npm run deploy
```

新增 D1 结构时创建新的顺序迁移文件，不要修改已经在线执行过的 `migrations/0001_init.sql`。

线上双端冒烟测试脚本位于 `scripts/smoke-live.mjs`。它会创建临时账号，测试完成后需使用 Wrangler 从 D1 删除该账号。

## 安全设计

- 密码使用 PBKDF2-SHA-256、随机盐和 Workers 支持的 100,000 次迭代。
- 会话 token 与 WebSocket ticket 只以 SHA-256 摘要形式保存。
- ticket 单次消费，过期后无法连接。
- WebSocket 使用 Durable Objects Hibernation API，JSON ping/pong 可自动响应而无需唤醒实例。
- 请求和 WebSocket 消息均有大小限制，SQL 全部使用绑定参数。
- 手机端只下发结构化 Agent 任务，不提供远程 shell 接口。
