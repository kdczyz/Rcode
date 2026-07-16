import { DurableObject } from "cloudflare:workers";

type RemoteRole = "agent" | "controller";
type RemoteAction = "agent.run" | "agent.approve";
type CommandStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed";

interface RemoteDeviceInput {
  id: string;
  name: string;
  platform: string;
  appVersion?: string;
  projectName?: string;
  ready?: boolean;
}

interface TicketInput {
  role: RemoteRole;
  device?: RemoteDeviceInput;
}

interface TicketRecord extends TicketInput {
  expiresAt: number;
}

interface ConnectionAttachment {
  role: RemoteRole;
  deviceId?: string;
  connectedAt: number;
}

interface DeviceRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  platform: string;
  app_version: string | null;
  project_name: string | null;
  ready: number;
  first_seen_at: number;
  last_seen_at: number;
}

interface CommandRow extends Record<string, SqlStorageValue> {
  id: string;
  request_id: string;
  device_id: string;
  action: RemoteAction;
  payload_json: string;
  status: CommandStatus;
  summary: string | null;
  created_at: number;
  updated_at: number;
}

const TICKET_TTL_MS = 60_000;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_PROMPT_CHARS = 8_000;
const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function normalizeDevice(value: unknown): RemoteDeviceInput | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanText(value.id, 128);
  const name = cleanText(value.name, 100);
  const platform = cleanText(value.platform, 40);
  if (!id || !name || !platform || !/^[a-zA-Z0-9._:-]+$/.test(id)) return undefined;
  return {
    id,
    name,
    platform,
    appVersion: cleanText(value.appVersion, 40),
    projectName: cleanText(value.projectName, 160),
    ready: value.ready === true
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeSend(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // A disconnect between readyState and send is expected during network changes.
  }
}

export class RemoteSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          app_version TEXT,
          project_name TEXT,
          ready INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS commands (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          device_id TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS commands_device_created_idx
          ON commands(device_id, created_at DESC);
      `);
    });
  }

  async issueTicket(input: TicketInput): Promise<{ ticket: string; expiresAt: number }> {
    if (input.role !== "agent" && input.role !== "controller") throw new Error("invalid remote role");
    const device = input.role === "agent" ? normalizeDevice(input.device) : undefined;
    if (input.role === "agent" && !device) throw new Error("agent device metadata is required");

    const ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + TICKET_TTL_MS;
    await this.ctx.storage.put(`ticket:${await sha256(ticket)}`, { role: input.role, device, expiresAt } satisfies TicketRecord);
    return { ticket, expiresAt };
  }

  async snapshot(): Promise<{ devices: unknown[]; commands: unknown[] }> {
    const onlineDeviceIds = new Set(
      this.ctx.getWebSockets("role:agent")
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .map((socket) => (socket.deserializeAttachment() as ConnectionAttachment | null)?.deviceId)
        .filter((value): value is string => Boolean(value))
    );
    const devices = this.ctx.storage.sql.exec<DeviceRow>(
      `SELECT id, name, platform, app_version, project_name, ready, first_seen_at, last_seen_at
       FROM devices ORDER BY last_seen_at DESC LIMIT 100`
    ).toArray().map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      appVersion: row.app_version ?? undefined,
      projectName: row.project_name ?? undefined,
      ready: row.ready === 1,
      online: onlineDeviceIds.has(row.id),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    }));
    const commands = this.ctx.storage.sql.exec<CommandRow>(
      `SELECT id, request_id, device_id, action, payload_json, status, summary, created_at, updated_at
       FROM commands ORDER BY created_at DESC LIMIT 50`
    ).toArray().map((row) => this.publicCommand(row));
    return { devices, commands };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    if (!ticket || ticket.length > 160) return new Response("Invalid ticket", { status: 401 });
    const key = `ticket:${await sha256(ticket)}`;
    const record = await this.ctx.storage.get<TicketRecord>(key);
    await this.ctx.storage.delete(key);
    if (!record || record.expiresAt < Date.now()) return new Response("Expired ticket", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: ConnectionAttachment = {
      role: record.role,
      deviceId: record.device?.id,
      connectedAt: Date.now()
    };
    server.serializeAttachment(attachment);
    const tags = [`role:${record.role}`];
    if (record.device) tags.push(`device:${record.device.id}`);
    this.ctx.acceptWebSocket(server, tags);

    if (record.device) {
      this.upsertDevice(record.device);
      this.deliverQueuedCommands(record.device.id, server);
      this.broadcastSnapshot();
    } else {
      safeSend(server, { type: "remote.ready", snapshot: await this.snapshot() });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const byteLength = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }
    let body: unknown;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      body = JSON.parse(text);
    } catch {
      safeSend(socket, { type: "remote.error", code: "invalid_json", error: "消息格式不正确" });
      return;
    }
    if (!isRecord(body) || typeof body.type !== "string") return;
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) return;

    if (body.type === "ping") {
      if (attachment.deviceId) this.touchDevice(attachment.deviceId);
      safeSend(socket, { type: "pong", at: Date.now() });
      return;
    }

    if (attachment.role === "controller") {
      await this.handleControllerMessage(socket, body);
      return;
    }
    await this.handleAgentMessage(attachment.deviceId, body);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (attachment?.deviceId) {
      this.touchDevice(attachment.deviceId);
      this.broadcastSnapshot();
    }
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (attachment?.deviceId) {
      this.touchDevice(attachment.deviceId);
      this.broadcastSnapshot();
    }
  }

  private async handleControllerMessage(socket: WebSocket, body: Record<string, unknown>): Promise<void> {
    if (body.type !== "command.create") return;
    const requestId = cleanText(body.requestId, 128);
    const deviceId = cleanText(body.deviceId, 128);
    const action = body.action === "agent.run" || body.action === "agent.approve" ? body.action : undefined;
    const payload = isRecord(body.payload) ? body.payload : undefined;
    if (!requestId || !deviceId || !action || !payload) {
      safeSend(socket, { type: "remote.error", code: "invalid_command", error: "远程指令参数不完整" });
      return;
    }
    if (action === "agent.run") {
      const prompt = cleanText(payload.prompt, MAX_PROMPT_CHARS);
      if (!prompt) {
        safeSend(socket, { type: "remote.error", code: "invalid_prompt", error: "请输入远程任务" });
        return;
      }
      payload.prompt = prompt;
      payload.mode = payload.mode === "plan" ? "plan" : "workspace_write";
    } else if (!cleanText(payload.approvalId, 160)) {
      safeSend(socket, { type: "remote.error", code: "invalid_approval", error: "审批指令缺少 approvalId" });
      return;
    }

    const existing = this.ctx.storage.sql.exec<CommandRow>(
      `SELECT id, request_id, device_id, action, payload_json, status, summary, created_at, updated_at
       FROM commands WHERE request_id = ? LIMIT 1`,
      requestId
    ).toArray()[0];
    if (existing) {
      safeSend(socket, { type: "command.accepted", command: this.publicCommand(existing) });
      return;
    }

    const now = Date.now();
    const command: CommandRow = {
      id: crypto.randomUUID(),
      request_id: requestId,
      device_id: deviceId,
      action,
      payload_json: JSON.stringify(payload),
      status: "queued",
      summary: null,
      created_at: now,
      updated_at: now
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO commands (id, request_id, device_id, action, payload_json, status, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.id,
      command.request_id,
      command.device_id,
      command.action,
      command.payload_json,
      command.status,
      command.summary,
      command.created_at,
      command.updated_at
    );
    this.ctx.storage.sql.exec("DELETE FROM commands WHERE created_at < ?", now - COMMAND_RETENTION_MS);
    const publicCommand = this.publicCommand(command);
    safeSend(socket, { type: "command.accepted", command: publicCommand });
    this.broadcastControllers({ type: "command.updated", command: publicCommand });
    this.deliverQueuedCommands(deviceId);
  }

  private async handleAgentMessage(deviceId: string | undefined, body: Record<string, unknown>): Promise<void> {
    if (!deviceId) return;
    this.touchDevice(deviceId);
    if (body.type === "device.update") {
      const current = this.ctx.storage.sql.exec<DeviceRow>(
        `SELECT id, name, platform, app_version, project_name, ready, first_seen_at, last_seen_at
         FROM devices WHERE id = ? LIMIT 1`,
        deviceId
      ).toArray()[0];
      if (current) {
        this.upsertDevice({
          id: deviceId,
          name: cleanText(body.name, 100) ?? current.name,
          platform: cleanText(body.platform, 40) ?? current.platform,
          appVersion: cleanText(body.appVersion, 40) ?? current.app_version ?? undefined,
          projectName: cleanText(body.projectName, 160),
          ready: body.ready === true
        });
        this.broadcastSnapshot();
      }
      return;
    }
    const commandId = cleanText(body.commandId, 128);
    if (!commandId) return;
    const command = this.findCommand(commandId, deviceId);
    if (!command) return;

    if (body.type === "command.started") {
      this.updateCommand(command, "running");
      return;
    }
    if (body.type === "command.event") {
      const event = isRecord(body.event) ? body.event : undefined;
      if (!event) return;
      if (event.type === "approval_required") this.updateCommand(command, "awaiting_approval", "等待远程审批");
      this.broadcastControllers({ type: "command.event", commandId, event });
      return;
    }
    if (body.type === "command.completed") {
      const ok = body.ok === true;
      this.updateCommand(command, ok ? "completed" : "failed", cleanText(body.summary, 2_000));
    }
  }

  private findCommand(commandId: string, deviceId: string): CommandRow | undefined {
    return this.ctx.storage.sql.exec<CommandRow>(
      `SELECT id, request_id, device_id, action, payload_json, status, summary, created_at, updated_at
       FROM commands WHERE id = ? AND device_id = ? LIMIT 1`,
      commandId,
      deviceId
    ).toArray()[0];
  }

  private updateCommand(command: CommandRow, status: CommandStatus, summary?: string): void {
    const updated: CommandRow = { ...command, status, summary: summary ?? command.summary, updated_at: Date.now() };
    this.ctx.storage.sql.exec(
      "UPDATE commands SET status = ?, summary = ?, updated_at = ? WHERE id = ?",
      updated.status,
      updated.summary,
      updated.updated_at,
      updated.id
    );
    this.broadcastControllers({ type: "command.updated", command: this.publicCommand(updated) });
  }

  private deliverQueuedCommands(deviceId: string, preferredSocket?: WebSocket): void {
    const socket = preferredSocket ?? this.ctx.getWebSockets(`device:${deviceId}`).find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) return;
    const queued = this.ctx.storage.sql.exec<CommandRow>(
      `SELECT id, request_id, device_id, action, payload_json, status, summary, created_at, updated_at
       FROM commands WHERE device_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 20`,
      deviceId
    ).toArray();
    for (const command of queued) {
      safeSend(socket, {
        type: "command.dispatch",
        command: {
          ...this.publicCommand(command),
          payload: JSON.parse(command.payload_json) as unknown
        }
      });
    }
  }

  private upsertDevice(device: RemoteDeviceInput): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (id, name, platform, app_version, project_name, ready, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
         app_version = excluded.app_version, project_name = excluded.project_name,
         ready = excluded.ready, last_seen_at = excluded.last_seen_at`,
      device.id,
      device.name,
      device.platform,
      device.appVersion ?? null,
      device.projectName ?? null,
      device.ready ? 1 : 0,
      now,
      now
    );
  }

  private touchDevice(deviceId: string): void {
    this.ctx.storage.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", Date.now(), deviceId);
  }

  private publicCommand(command: CommandRow): Record<string, unknown> {
    return {
      id: command.id,
      requestId: command.request_id,
      deviceId: command.device_id,
      action: command.action,
      status: command.status,
      summary: command.summary ?? undefined,
      createdAt: command.created_at,
      updatedAt: command.updated_at
    };
  }

  private broadcastControllers(message: unknown): void {
    for (const socket of this.ctx.getWebSockets("role:controller")) safeSend(socket, message);
  }

  private broadcastSnapshot(): void {
    this.ctx.waitUntil(this.snapshot().then((snapshot) => this.broadcastControllers({ type: "remote.snapshot", snapshot })));
  }
}
