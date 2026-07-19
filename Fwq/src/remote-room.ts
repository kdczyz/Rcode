import { DurableObject } from "cloudflare:workers";
import { isObject } from "./http";

type Role = "controller" | "agent";
type CommandStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed";

interface ConnectionAttachment {
  role: Role;
  userId: string;
  deviceId?: string;
  connectedAt: number;
}

interface DeviceMetadata {
  id: string;
  name: string;
  platform: string;
  appVersion?: string;
  projectName?: string;
  workspace?: RemoteWorkspace;
  ready: boolean;
}

interface RemoteWorkspaceSession {
  id: string;
  title: string;
  updatedAt: string;
  conversationId?: string;
}

interface RemoteWorkspaceProject {
  id: string;
  name: string;
  sessions: RemoteWorkspaceSession[];
}

interface RemoteWorkspace {
  projects: RemoteWorkspaceProject[];
  models: string[];
  defaultModel?: string;
  activeProjectId?: string;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  app_version: string | null;
  project_name: string | null;
  workspace_json: string | null;
  ready: number;
  last_seen_at: number;
}

interface CommandRow {
  id: string;
  request_id: string;
  device_id: string;
  action: "agent.run" | "agent.approve";
  status: CommandStatus;
  summary: string | null;
  payload_json: string;
  created_at: number;
  updated_at: number;
}

interface CommandEventRow {
  id: string;
  command_id: string;
  type: string;
  event_json: string;
  created_at: number;
}

function isRole(value: unknown): value is Role {
  return value === "controller" || value === "agent";
}

function attachmentOf(socket: WebSocket): ConnectionAttachment | undefined {
  const value: unknown = socket.deserializeAttachment();
  if (!isObject(value) || !isRole(value.role) || typeof value.userId !== "string" || typeof value.connectedAt !== "number") return undefined;
  if (value.deviceId !== undefined && typeof value.deviceId !== "string") return undefined;
  return {
    role: value.role,
    userId: value.userId,
    deviceId: value.deviceId,
    connectedAt: value.connectedAt
  };
}

function commandFromRow(row: CommandRow) {
  let metadata: Record<string, unknown> = {};
  try {
    const payload: unknown = JSON.parse(row.payload_json);
    if (isObject(payload)) metadata = payload;
  } catch { /* malformed legacy payloads have no public metadata */ }
  return {
    id: row.id,
    requestId: row.request_id,
    deviceId: row.device_id,
    action: row.action,
    status: row.status,
    summary: row.summary ?? undefined,
    projectId: stringField(metadata.projectId, 128),
    sessionId: stringField(metadata.sessionId, 128),
    model: stringField(metadata.model, 160),
    conversationId: stringField(metadata.conversationId, 256),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify(payload)); } catch { /* the close handler will reconcile presence */ }
}

function stringField(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function parseWorkspace(value: unknown): RemoteWorkspace | undefined {
  if (!isObject(value) || !Array.isArray(value.projects) || !Array.isArray(value.models)) return undefined;
  const projects = value.projects.slice(0, 50).flatMap((rawProject) => {
    if (!isObject(rawProject)) return [];
    const id = stringField(rawProject.id, 128);
    const name = stringField(rawProject.name, 160);
    if (!id || !name || !Array.isArray(rawProject.sessions)) return [];
    const sessions = rawProject.sessions.slice(0, 30).flatMap((rawSession) => {
      if (!isObject(rawSession)) return [];
      const sessionId = stringField(rawSession.id, 128);
      const title = stringField(rawSession.title, 160);
      const updatedAt = stringField(rawSession.updatedAt, 64);
      if (!sessionId || !title || !updatedAt) return [];
      return [{ id: sessionId, title, updatedAt, conversationId: stringField(rawSession.conversationId, 256) }];
    });
    return [{ id, name, sessions }];
  });
  const models = value.models.flatMap((rawModel) => {
    const model = stringField(rawModel, 160);
    return model ? [model] : [];
  }).slice(0, 60);
  return {
    projects,
    models: [...new Set(models)],
    defaultModel: stringField(value.defaultModel, 160),
    activeProjectId: stringField(value.activeProjectId, 128)
  };
}

function parseDevice(value: unknown): DeviceMetadata | undefined {
  if (!isObject(value)) return undefined;
  const id = stringField(value.id, 128);
  const name = stringField(value.name, 128);
  const platform = stringField(value.platform, 64);
  if (!id || !name || !platform) return undefined;
  const workspace = value.workspace === undefined ? undefined : parseWorkspace(value.workspace);
  if (value.workspace !== undefined && !workspace) return undefined;
  if (workspace && JSON.stringify(workspace).length > 48 * 1024) return undefined;
  return {
    id,
    name,
    platform,
    appVersion: stringField(value.appVersion, 64),
    projectName: stringField(value.projectName, 256),
    workspace,
    ready: value.ready === true
  };
}

export class RemoteRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const role = request.headers.get("x-rcode-role");
    const userId = request.headers.get("x-rcode-user-id");
    if (!isRole(role) || !userId) return new Response("Unauthorized", { status: 401 });

    let device: DeviceMetadata | undefined;
    if (role === "agent") {
      try { device = parseDevice(JSON.parse(request.headers.get("x-rcode-device") || "null")); } catch { device = undefined; }
      if (!device) return new Response("Agent device metadata required", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      role,
      userId,
      deviceId: device?.id,
      connectedAt: Date.now()
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [role, ...(device ? [`device:${device.id}`] : [])]);

    if (device) await this.upsertDevice(userId, device, true);
    safeSend(server, { type: "remote.ready", snapshot: await this.snapshot(userId) });
    if (device) await this.broadcastSnapshot(userId);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(socket);
    if (!attachment) {
      socket.close(1008, "Invalid connection state");
      return;
    }
    const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
    if (text.length > 64 * 1024) {
      socket.close(1009, "Message too large");
      return;
    }

    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) throw new Error("not an object");
      message = parsed;
    } catch {
      safeSend(socket, { type: "remote.error", error: "消息格式不正确" });
      return;
    }

    if (message.type === "ping") {
      safeSend(socket, { type: "pong", at: Date.now() });
      return;
    }
    if (attachment.role === "controller" && message.type === "command.create") {
      await this.createCommand(socket, attachment, message);
      return;
    }
    if (attachment.role === "controller" && message.type === "command.stop") {
      await this.stopCommand(socket, attachment, message);
      return;
    }
    if (attachment.role === "agent" && message.type === "device.announce") {
      const device = parseDevice(message.device);
      if (!device || device.id !== attachment.deviceId) {
        safeSend(socket, { type: "remote.error", error: "设备信息不正确" });
        return;
      }
      await this.upsertDevice(attachment.userId, device, true);
      await this.broadcastSnapshot(attachment.userId);
      return;
    }
    if (attachment.role === "agent" && message.type === "command.updated") {
      await this.updateCommand(socket, attachment, message);
      return;
    }
    if (attachment.role === "agent" && message.type === "command.event") {
      await this.recordEvent(socket, attachment, message);
      return;
    }
    safeSend(socket, { type: "remote.error", error: "当前连接不允许此操作" });
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.reconcileDisconnect(socket);
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ level: "error", message: "remote websocket error", error: String(error), timestamp: new Date().toISOString() }));
    await this.reconcileDisconnect(socket);
  }

  private async reconcileDisconnect(socket: WebSocket): Promise<void> {
    const attachment = attachmentOf(socket);
    if (attachment?.role !== "agent" || !attachment.deviceId) return;
    const otherOpenConnection = this.ctx.getWebSockets(`device:${attachment.deviceId}`)
      .some((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN);
    if (otherOpenConnection) return;
    await this.env.DB.prepare(
      "UPDATE devices SET online = 0, ready = 0, last_seen_at = ? WHERE user_id = ? AND id = ?"
    ).bind(Date.now(), attachment.userId, attachment.deviceId).run();
    await this.broadcastSnapshot(attachment.userId);
  }

  private async upsertDevice(userId: string, device: DeviceMetadata, online: boolean): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(`
      INSERT INTO devices (id, user_id, name, platform, app_version, project_name, workspace_json, ready, online, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        app_version = excluded.app_version,
        project_name = excluded.project_name,
        workspace_json = excluded.workspace_json,
        ready = excluded.ready,
        online = excluded.online,
        last_seen_at = excluded.last_seen_at
    `).bind(
      device.id,
      userId,
      device.name,
      device.platform,
      device.appVersion ?? null,
      device.projectName ?? null,
      device.workspace ? JSON.stringify(device.workspace) : null,
      device.ready ? 1 : 0,
      online ? 1 : 0,
      now
    ).run();
  }

  private async snapshot(userId: string): Promise<{ devices: unknown[]; commands: unknown[]; events: unknown[] }> {
    const [deviceResult, commandResult, eventResult] = await Promise.all([
      this.env.DB.prepare(`
        SELECT id, name, platform, app_version, project_name, workspace_json, ready, last_seen_at
          FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 100
      `).bind(userId).all<DeviceRow>(),
      this.env.DB.prepare(`
        SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
          FROM commands WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
      `).bind(userId).all<CommandRow>(),
      this.env.DB.prepare(`
        SELECT id, command_id, type, event_json, created_at
          FROM command_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 400
      `).bind(userId).all<CommandEventRow>()
    ]);
    const onlineDeviceIds = new Set(
      this.ctx.getWebSockets("agent")
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .map((socket) => attachmentOf(socket)?.deviceId)
        .filter((id): id is string => typeof id === "string")
    );
    return {
      devices: deviceResult.results.map((row) => {
        let workspace: RemoteWorkspace | undefined;
        try { workspace = parseWorkspace(JSON.parse(row.workspace_json || "null")); } catch { workspace = undefined; }
        return {
        id: row.id,
        name: row.name,
        platform: row.platform,
        appVersion: row.app_version ?? undefined,
        projectName: row.project_name ?? undefined,
        workspace,
        ready: onlineDeviceIds.has(row.id) && row.ready === 1,
        online: onlineDeviceIds.has(row.id),
        lastSeenAt: row.last_seen_at
        };
      }),
      commands: commandResult.results.map(commandFromRow),
      events: eventResult.results.reverse().flatMap((row) => {
        try {
          const event: unknown = JSON.parse(row.event_json);
          return isObject(event)
            ? [{ id: row.id, commandId: row.command_id, type: row.type, event, createdAt: row.created_at }]
            : [];
        } catch { return []; }
      })
    };
  }

  private async broadcastSnapshot(userId: string): Promise<void> {
    const message = { type: "remote.snapshot", snapshot: await this.snapshot(userId) };
    for (const socket of this.ctx.getWebSockets("controller")) safeSend(socket, message);
  }

  private broadcastToControllers(payload: unknown): void {
    for (const socket of this.ctx.getWebSockets("controller")) safeSend(socket, payload);
  }

  private async createCommand(socket: WebSocket, attachment: ConnectionAttachment, message: Record<string, unknown>): Promise<void> {
    const requestId = stringField(message.requestId, 128);
    const deviceId = stringField(message.deviceId, 128);
    const action = message.action;
    const payload = message.payload;
    if (!requestId || !deviceId || (action !== "agent.run" && action !== "agent.approve") || !isObject(payload)) {
      safeSend(socket, { type: "remote.error", error: "任务参数不正确" });
      return;
    }
    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > 48 * 1024) {
      safeSend(socket, { type: "remote.error", error: "任务内容过大" });
      return;
    }
    const existing = await this.commandByRequest(attachment.userId, requestId);
    if (existing) {
      safeSend(socket, { type: "command.accepted", command: commandFromRow(existing) });
      return;
    }
    const agents = this.ctx.getWebSockets(`device:${deviceId}`).filter((candidate) => candidate.readyState === WebSocket.OPEN);
    if (agents.length === 0) {
      safeSend(socket, { type: "remote.error", error: "目标电脑当前不在线" });
      return;
    }
    const device = await this.env.DB.prepare(
      "SELECT id FROM devices WHERE user_id = ? AND id = ?"
    ).bind(attachment.userId, deviceId).first<{ id: string }>();
    if (!device) {
      safeSend(socket, { type: "remote.error", error: "找不到目标电脑" });
      return;
    }

    const now = Date.now();
    const commandId = crypto.randomUUID();
    const summary = action === "agent.run" && typeof payload.prompt === "string" ? payload.prompt.slice(0, 500) : null;
    try {
      await this.env.DB.prepare(`
        INSERT INTO commands (id, request_id, user_id, device_id, action, status, summary, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `).bind(commandId, requestId, attachment.userId, deviceId, action, summary, payloadJson, now, now).run();
    } catch (error) {
      const raced = await this.commandByRequest(attachment.userId, requestId);
      if (!raced) throw error;
      safeSend(socket, { type: "command.accepted", command: commandFromRow(raced) });
      return;
    }

    const row: CommandRow = {
      id: commandId,
      request_id: requestId,
      device_id: deviceId,
      action,
      status: "queued",
      summary,
      payload_json: payloadJson,
      created_at: now,
      updated_at: now
    };
    const command = commandFromRow(row);
    this.broadcastToControllers({ type: "command.accepted", command });
    for (const agent of agents) safeSend(agent, { type: "command.execute", command, payload });
  }

  private async commandByRequest(userId: string, requestId: string): Promise<CommandRow | null> {
    return this.env.DB.prepare(`
      SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
        FROM commands WHERE user_id = ? AND request_id = ?
    `).bind(userId, requestId).first<CommandRow>();
  }

  private async stopCommand(socket: WebSocket, attachment: ConnectionAttachment, message: Record<string, unknown>): Promise<void> {
    const deviceId = stringField(message.deviceId, 128);
    const targetCommandId = stringField(message.targetCommandId, 128);
    const targetRequestId = stringField(message.targetRequestId, 128);
    if (!deviceId || (!targetCommandId && !targetRequestId)) {
      safeSend(socket, { type: "remote.error", error: "终止任务参数不正确" });
      return;
    }

    let target = targetCommandId
      ? await this.env.DB.prepare(`
          SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
            FROM commands WHERE id = ? AND user_id = ? AND device_id = ?
        `).bind(targetCommandId, attachment.userId, deviceId).first<CommandRow>()
      : null;
    if (!target && targetRequestId) {
      target = await this.env.DB.prepare(`
          SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
            FROM commands WHERE request_id = ? AND user_id = ? AND device_id = ?
        `).bind(targetRequestId, attachment.userId, deviceId).first<CommandRow>();
    }
    if (!target) {
      safeSend(socket, { type: "remote.error", error: "找不到需要终止的任务" });
      return;
    }
    if (target.status === "completed" || target.status === "failed") {
      safeSend(socket, { type: "command.updated", command: commandFromRow(target) });
      return;
    }

    const now = Date.now();
    const stoppedEvent = { type: "stopped", message: "已从手机端终止本次会话" };
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE commands SET status = 'failed', summary = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      ).bind("已终止", now, target.id, attachment.userId),
      this.env.DB.prepare(`
        INSERT INTO command_events (id, command_id, user_id, type, event_json, created_at)
        VALUES (?, ?, ?, 'stopped', ?, ?)
      `).bind(crypto.randomUUID(), target.id, attachment.userId, JSON.stringify(stoppedEvent), now)
    ]);

    const stoppedCommand = commandFromRow({ ...target, status: "failed", summary: "已终止", updated_at: now });
    this.broadcastToControllers({ type: "command.updated", command: stoppedCommand });
    this.broadcastToControllers({ type: "command.event", commandId: target.id, event: stoppedEvent });
    const agents = this.ctx.getWebSockets(`device:${deviceId}`).filter((candidate) => candidate.readyState === WebSocket.OPEN);
    for (const agent of agents) {
      safeSend(agent, { type: "command.stop", commandId: target.id, requestId: target.request_id });
    }
  }

  private async updateCommand(socket: WebSocket, attachment: ConnectionAttachment, message: Record<string, unknown>): Promise<void> {
    const value = message.command;
    if (!isObject(value)) {
      safeSend(socket, { type: "remote.error", error: "任务状态格式不正确" });
      return;
    }
    const id = stringField(value.id, 128);
    const status = value.status;
    const allowedStatus = status === "queued" || status === "running" || status === "awaiting_approval" || status === "completed" || status === "failed";
    if (!id || !allowedStatus) {
      safeSend(socket, { type: "remote.error", error: "任务状态格式不正确" });
      return;
    }
    const existing = await this.env.DB.prepare(`
      SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
        FROM commands WHERE id = ? AND user_id = ? AND device_id = ?
    `).bind(id, attachment.userId, attachment.deviceId ?? "").first<CommandRow>();
    if (!existing) {
      safeSend(socket, { type: "remote.error", error: "找不到对应任务" });
      return;
    }
    // A late local error/completion after a remote stop must not resurrect the
    // command or replace its terminal stopped state.
    if (existing.status === "failed" && existing.summary === "已终止") {
      safeSend(socket, { type: "command.updated", command: commandFromRow(existing) });
      return;
    }
    const updatedAt = Date.now();
    const summary = typeof value.summary === "string" ? value.summary.slice(0, 500) : existing.summary;
    await this.env.DB.prepare(
      "UPDATE commands SET status = ?, summary = ?, updated_at = ? WHERE id = ? AND user_id = ?"
    ).bind(status, summary, updatedAt, id, attachment.userId).run();
    this.broadcastToControllers({
      type: "command.updated",
      command: commandFromRow({ ...existing, status, summary, updated_at: updatedAt })
    });
  }

  private async recordEvent(socket: WebSocket, attachment: ConnectionAttachment, message: Record<string, unknown>): Promise<void> {
    const commandId = stringField(message.commandId, 128);
    const event = message.event;
    if (!commandId || !isObject(event) || typeof event.type !== "string" || event.type.length > 64) {
      safeSend(socket, { type: "remote.error", error: "任务事件格式不正确" });
      return;
    }
    const eventJson = JSON.stringify(event);
    if (eventJson.length > 48 * 1024) {
      safeSend(socket, { type: "remote.error", error: "任务事件过大" });
      return;
    }
    const existing = await this.env.DB.prepare(`
      SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
        FROM commands WHERE id = ? AND user_id = ? AND device_id = ?
    `).bind(commandId, attachment.userId, attachment.deviceId ?? "").first<CommandRow>();
    if (!existing) {
      safeSend(socket, { type: "remote.error", error: "找不到对应任务" });
      return;
    }
    if (existing.status === "failed" && existing.summary === "已终止") {
      safeSend(socket, { type: "command.updated", command: commandFromRow(existing) });
      return;
    }
    const now = Date.now();
    let nextStatus: CommandStatus | undefined;
    if (event.type === "approval_required") nextStatus = "awaiting_approval";
    if (event.type === "completed") nextStatus = "completed";
    if (event.type === "error") nextStatus = "failed";
    const statements = [
      this.env.DB.prepare(`
        INSERT INTO command_events (id, command_id, user_id, type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), commandId, attachment.userId, event.type, eventJson, now)
    ];
    if (nextStatus) {
      statements.push(this.env.DB.prepare(
        "UPDATE commands SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      ).bind(nextStatus, now, commandId, attachment.userId));
    }
    await this.env.DB.batch(statements);
    if (nextStatus) {
      this.broadcastToControllers({
        type: "command.updated",
        command: commandFromRow({ ...existing, status: nextStatus, updated_at: now })
      });
    }
    this.broadcastToControllers({ type: "command.event", commandId, event });
  }
}
