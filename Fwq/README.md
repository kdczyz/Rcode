# Rcode Remote Server

Rcode 安卓端与电脑 Agent 的 Cloudflare 服务端。HTTP API 运行在 Workers，账号、会话、设备和任务保存在 D1，每个账号由独立 Durable Object 协调实时 WebSocket 连接。

## 已部署环境

- API：`https://lxqandlzy.me`
- 健康检查：`GET /health`
- D1：`rcode-remote-db`（APAC）
- Durable Object：`RemoteRoom`

安卓端使用：

```env
VITE_AUTH_API_URL=https://lxqandlzy.me
```

## HTTP API

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/auth/logout`
- `GET /v1/work/ai-config`
- `PUT /v1/work/ai-config`
- `DELETE /v1/work/ai-config`
- `POST /v1/work/chat`
- `POST /v1/work/images`
- `POST /v1/remote/ticket`
- `GET /v1/remote/connect?ticket=...`（WebSocket Upgrade）

除注册和登录外均使用 `Authorization: Bearer <token>`。会话有效期 30 天；远程 ticket 为 60 秒有效的一次性凭证。

Work 模式把每个账号的 OpenAI 兼容接口配置保存在 D1。API Key 通过 Worker Secret `AI_CONFIG_SECRET` 派生的 AES-GCM 密钥加密，读取配置时只返回末四位预览；`POST /v1/work/chat` 和 `POST /v1/work/images` 由 Worker 代为请求上游，因此电脑离线时仍可聊天和生成图片。图片接口默认使用 OpenAI 兼容的 `/images/generations` 路径。首次部署前设置一次稳定的随机密钥：

电脑端登录账号后，会把当前启用的 AI 接口通过受保护的 Electron 主进程同步到 `PUT /v1/work/ai-config`。同账号手机端重新进入 Work 或恢复到前台时会刷新配置；Code 远程控制仍通过该账号对应的 Durable Object 房间连接在线电脑。

```bash
openssl rand -base64 48 | npx wrangler secret put AI_CONFIG_SECRET
```

不要轮换或删除该密钥，除非准备让所有用户重新保存 API Key。

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
    "workspace": {
      "activeProjectId": "project-id",
      "defaultModel": "gpt-5.6-codex",
      "models": ["gpt-5.6-codex"],
      "projects": [{
        "id": "project-id",
        "name": "Rcode",
        "sessions": [{ "id": "session-id", "title": "新会话", "updatedAt": "2026-07-18T00:00:00.000Z" }]
      }]
    },
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

权限隔离在服务端执行：控制端不能伪造 Agent 状态，Agent 只能更新自身设备的任务；每个用户映射到独立 Durable Object。电脑端只发布项目 ID、名称和会话元数据，本机绝对路径不会上传；远程任务由电脑端把项目 ID 映射回已公开的本机路径。

## 本地开发

可以在仓库根目录使用统一命令 `npm run remote:dev`、`npm run remote:check` 和 `npm run remote:test`，也可以进入本目录直接运行：

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
- Work API Key 使用随机 IV 的 AES-GCM 加密，配置接口永不返回明文。
- 手机端只下发结构化 Agent 任务，不提供远程 shell 接口。
