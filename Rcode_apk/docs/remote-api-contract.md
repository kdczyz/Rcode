# Rcode Mobile 远程接口契约（预留）

本文只描述安卓客户端已经预留的通信边界，不包含服务端实现。字段可以扩展，但现有字段不应改变语义。

## HTTP

所有接口使用 JSON。除登录、注册外，请求携带 `Authorization: Bearer <token>`。

### `POST /v1/auth/login`

请求：`{ identifier, password }`

### `POST /v1/auth/register`

请求：`{ email, username, displayName, password }`

登录与注册成功响应：

```json
{
  "token": "session-token",
  "expiresAt": "2026-07-18T00:00:00.000Z",
  "user": {
    "id": "user-id",
    "email": "name@example.com",
    "username": "name",
    "displayName": "Name"
  }
}
```

### `GET /v1/auth/me`

响应：`{ "user": User }`

### `POST /v1/auth/logout`

撤销当前会话。响应体可以为空 JSON 对象。

### `POST /v1/remote/ticket`

请求：`{ "role": "controller" }`

响应：`{ "url": "wss://...一次性连接地址..." }`

连接地址必须使用 `ws://` 或 `wss://`；生产环境应只返回短期有效的 `wss://` 地址。

## WebSocket

客户端连接成功后等待 `remote.ready` 或 `remote.snapshot`。客户端每 25 秒发送一次 `{ "type": "ping" }`，60 秒未收到任何消息会主动重连。

### 设备与任务快照

```json
{
  "type": "remote.snapshot",
  "snapshot": {
    "devices": [{
      "id": "device-id",
      "name": "MacBook Pro",
      "platform": "darwin",
      "appVersion": "1.0.0",
      "projectName": "Rcode",
      "ready": true,
      "online": true,
      "lastSeenAt": 1784246400000
    }],
    "commands": []
  }
}
```

### 创建任务

```json
{
  "type": "command.create",
  "requestId": "request-id",
  "deviceId": "device-id",
  "action": "agent.run",
  "payload": {
    "prompt": "检查项目构建错误",
    "mode": "workspace_write"
  }
}
```

`mode` 目前为 `workspace_write` 或 `plan`。审批使用 `action: agent.approve`，payload 为 `{ approvalId, originCommandId, allow }`。

服务端接受或更新任务时发送 `command.accepted` / `command.updated`，并携带：

```json
{
  "command": {
    "id": "command-id",
    "requestId": "request-id",
    "deviceId": "device-id",
    "action": "agent.run",
    "status": "running",
    "summary": "检查项目构建错误",
    "createdAt": 1784246400000,
    "updatedAt": 1784246401000
  }
}
```

`status` 为 `queued`、`running`、`awaiting_approval`、`completed` 或 `failed`。

### 实时事件

```json
{
  "type": "command.event",
  "commandId": "command-id",
  "event": {
    "type": "workflow_state",
    "label": "正在检查构建"
  }
}
```

客户端当前识别 `text_delta`、`workflow_state`、`tool_call`、`permission_decision`、`approval_required`、`completed` 与 `error`。`approval_required` 至少包含 `approvalId`、`reason`、`risk`；`risk` 为 `low`、`medium` 或 `high`。

### 错误

```json
{ "type": "remote.error", "error": "可展示给用户的错误信息" }
```

## 客户端约束

- 手机端只提交 Agent 任务，不提供任意 shell 入口。
- `workspace_write` 仍服从电脑端工作区和权限策略。
- 每次审批只对应一个 `approvalId`，客户端不会提供永久允许选项。
- `requestId` 用于发送重试和乐观状态去重；服务端应保证同一用户内幂等。
