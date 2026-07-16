var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/http.ts
var MAX_JSON_BYTES = 64 * 1024;
var HttpError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
  status;
  code;
  static {
    __name(this, "HttpError");
  }
};
function corsHeaders() {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
}
__name(corsHeaders, "corsHeaders");
function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders() });
}
__name(json, "json");
async function readJsonObject(request) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > MAX_JSON_BYTES) throw new HttpError(413, "\u8BF7\u6C42\u5185\u5BB9\u8FC7\u5927", "payload_too_large");
  if (!request.body) throw new HttpError(400, "\u7F3A\u5C11\u8BF7\u6C42\u5185\u5BB9", "invalid_request");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "\u8BF7\u6C42\u5185\u5BB9\u8FC7\u5927", "payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "JSON \u683C\u5F0F\u4E0D\u6B63\u786E", "invalid_json");
  }
  if (!isObject(parsed)) throw new HttpError(400, "\u8BF7\u6C42\u5185\u5BB9\u5FC5\u987B\u662F JSON \u5BF9\u8C61", "invalid_request");
  return parsed;
}
__name(readJsonObject, "readJsonObject");
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isObject, "isObject");
function requiredString(value, field, options = {}) {
  if (typeof value !== "string") throw new HttpError(400, `${field} \u683C\u5F0F\u4E0D\u6B63\u786E`, "invalid_request");
  const normalized = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 256;
  if (normalized.length < min || normalized.length > max || options.pattern && !options.pattern.test(normalized)) {
    throw new HttpError(400, `${field} \u683C\u5F0F\u4E0D\u6B63\u786E`, "invalid_request");
  }
  return normalized;
}
__name(requiredString, "requiredString");
function logError(message, error, data = {}) {
  console.error(JSON.stringify({
    level: "error",
    message,
    error: error instanceof Error ? error.message : String(error),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...data
  }));
}
__name(logError, "logError");

// src/auth.ts
var PASSWORD_ITERATIONS = 12e4;
var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(bytesToBase64Url, "bytesToBase64Url");
function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
__name(base64UrlToBytes, "base64UrlToBytes");
function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
__name(randomToken, "randomToken");
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}
__name(sha256, "sha256");
async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}
__name(derivePassword, "derivePassword");
async function createPasswordRecord(password) {
  validatePassword(password);
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const derived = await derivePassword(password, saltBytes, PASSWORD_ITERATIONS);
  return {
    salt: bytesToBase64Url(saltBytes),
    hash: bytesToBase64Url(derived),
    iterations: PASSWORD_ITERATIONS
  };
}
__name(createPasswordRecord, "createPasswordRecord");
async function verifyPassword(password, row) {
  let expected;
  let salt;
  try {
    expected = base64UrlToBytes(row.password_hash);
    salt = base64UrlToBytes(row.password_salt);
  } catch {
    return false;
  }
  const actual = await derivePassword(password, salt, row.password_iterations);
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}
__name(verifyPassword, "verifyPassword");
function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, "\u5BC6\u7801\u81F3\u5C11 8 \u4F4D\uFF0C\u5E76\u5305\u542B\u5B57\u6BCD\u548C\u6570\u5B57", "weak_password");
  }
}
__name(validatePassword, "validatePassword");
function publicUser(row) {
  return { id: row.id, email: row.email, username: row.username, displayName: row.display_name };
}
__name(publicUser, "publicUser");
async function createSession(db, userId) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt, now).run();
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}
__name(createSession, "createSession");
async function authenticate(request, db) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "\u8BF7\u5148\u767B\u5F55", "unauthorized");
  const token = authorization.slice(7).trim();
  if (!token || token.length > 256) throw new HttpError(401, "\u4F1A\u8BDD\u65E0\u6548", "unauthorized");
  const tokenHash = await sha256(token);
  const row = await db.prepare(`
    SELECT u.id, u.email, u.username, u.display_name, u.password_salt, u.password_hash,
           u.password_iterations, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first();
  if (!row) throw new HttpError(401, "\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55", "unauthorized");
  return { user: publicUser(row), tokenHash };
}
__name(authenticate, "authenticate");
function validateRegistration(body) {
  const email = requiredString(body.email, "\u90AE\u7BB1", { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E", "invalid_email");
  const username = requiredString(body.username, "\u7528\u6237\u540D", { min: 3, max: 32, pattern: /^[A-Za-z0-9_]+$/ }).toLowerCase();
  const displayName = requiredString(body.displayName, "\u663E\u793A\u540D\u79F0", { max: 64 });
  validatePassword(body.password);
  return { email, username, displayName, password: body.password };
}
__name(validateRegistration, "validateRegistration");

// src/remote-room.ts
import { DurableObject } from "cloudflare:workers";
function isRole(value) {
  return value === "controller" || value === "agent";
}
__name(isRole, "isRole");
function attachmentOf(socket) {
  const value = socket.deserializeAttachment();
  if (!isObject(value) || !isRole(value.role) || typeof value.userId !== "string" || typeof value.connectedAt !== "number") return void 0;
  if (value.deviceId !== void 0 && typeof value.deviceId !== "string") return void 0;
  return {
    role: value.role,
    userId: value.userId,
    deviceId: value.deviceId,
    connectedAt: value.connectedAt
  };
}
__name(attachmentOf, "attachmentOf");
function commandFromRow(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    deviceId: row.device_id,
    action: row.action,
    status: row.status,
    summary: row.summary ?? void 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(commandFromRow, "commandFromRow");
function safeSend(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
  }
}
__name(safeSend, "safeSend");
function stringField(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : void 0;
}
__name(stringField, "stringField");
function parseDevice(value) {
  if (!isObject(value)) return void 0;
  const id = stringField(value.id, 128);
  const name = stringField(value.name, 128);
  const platform = stringField(value.platform, 64);
  if (!id || !name || !platform) return void 0;
  return {
    id,
    name,
    platform,
    appVersion: stringField(value.appVersion, 64),
    projectName: stringField(value.projectName, 256),
    ready: value.ready === true
  };
}
__name(parseDevice, "parseDevice");
var RemoteRoom = class extends DurableObject {
  static {
    __name(this, "RemoteRoom");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
  }
  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const role = request.headers.get("x-rcode-role");
    const userId = request.headers.get("x-rcode-user-id");
    if (!isRole(role) || !userId) return new Response("Unauthorized", { status: 401 });
    let device;
    if (role === "agent") {
      try {
        device = parseDevice(JSON.parse(request.headers.get("x-rcode-device") || "null"));
      } catch {
        device = void 0;
      }
      if (!device) return new Response("Agent device metadata required", { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment = {
      role,
      userId,
      deviceId: device?.id,
      connectedAt: Date.now()
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [role, ...device ? [`device:${device.id}`] : []]);
    if (device) await this.upsertDevice(userId, device, true);
    safeSend(server, { type: "remote.ready", snapshot: await this.snapshot(userId) });
    if (device) await this.broadcastSnapshot(userId);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket, rawMessage) {
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
    let message;
    try {
      const parsed = JSON.parse(text);
      if (!isObject(parsed)) throw new Error("not an object");
      message = parsed;
    } catch {
      safeSend(socket, { type: "remote.error", error: "\u6D88\u606F\u683C\u5F0F\u4E0D\u6B63\u786E" });
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
    if (attachment.role === "agent" && message.type === "device.announce") {
      const device = parseDevice(message.device);
      if (!device || device.id !== attachment.deviceId) {
        safeSend(socket, { type: "remote.error", error: "\u8BBE\u5907\u4FE1\u606F\u4E0D\u6B63\u786E" });
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
    safeSend(socket, { type: "remote.error", error: "\u5F53\u524D\u8FDE\u63A5\u4E0D\u5141\u8BB8\u6B64\u64CD\u4F5C" });
  }
  async webSocketClose(socket) {
    await this.reconcileDisconnect(socket);
  }
  async webSocketError(socket, error) {
    console.error(JSON.stringify({ level: "error", message: "remote websocket error", error: String(error), timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
    await this.reconcileDisconnect(socket);
  }
  async reconcileDisconnect(socket) {
    const attachment = attachmentOf(socket);
    if (attachment?.role !== "agent" || !attachment.deviceId) return;
    const otherOpenConnection = this.ctx.getWebSockets(`device:${attachment.deviceId}`).some((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN);
    if (otherOpenConnection) return;
    await this.env.DB.prepare(
      "UPDATE devices SET online = 0, ready = 0, last_seen_at = ? WHERE user_id = ? AND id = ?"
    ).bind(Date.now(), attachment.userId, attachment.deviceId).run();
    await this.broadcastSnapshot(attachment.userId);
  }
  async upsertDevice(userId, device, online) {
    const now = Date.now();
    await this.env.DB.prepare(`
      INSERT INTO devices (id, user_id, name, platform, app_version, project_name, ready, online, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        app_version = excluded.app_version,
        project_name = excluded.project_name,
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
      device.ready ? 1 : 0,
      online ? 1 : 0,
      now
    ).run();
  }
  async snapshot(userId) {
    const [deviceResult, commandResult] = await Promise.all([
      this.env.DB.prepare(`
        SELECT id, name, platform, app_version, project_name, ready, last_seen_at
          FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 100
      `).bind(userId).all(),
      this.env.DB.prepare(`
        SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
          FROM commands WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
      `).bind(userId).all()
    ]);
    const onlineDeviceIds = new Set(
      this.ctx.getWebSockets("agent").filter((socket) => socket.readyState === WebSocket.OPEN).map((socket) => attachmentOf(socket)?.deviceId).filter((id) => typeof id === "string")
    );
    return {
      devices: deviceResult.results.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        appVersion: row.app_version ?? void 0,
        projectName: row.project_name ?? void 0,
        ready: onlineDeviceIds.has(row.id) && row.ready === 1,
        online: onlineDeviceIds.has(row.id),
        lastSeenAt: row.last_seen_at
      })),
      commands: commandResult.results.map(commandFromRow)
    };
  }
  async broadcastSnapshot(userId) {
    const message = { type: "remote.snapshot", snapshot: await this.snapshot(userId) };
    for (const socket of this.ctx.getWebSockets("controller")) safeSend(socket, message);
  }
  broadcastToControllers(payload) {
    for (const socket of this.ctx.getWebSockets("controller")) safeSend(socket, payload);
  }
  async createCommand(socket, attachment, message) {
    const requestId = stringField(message.requestId, 128);
    const deviceId = stringField(message.deviceId, 128);
    const action = message.action;
    const payload = message.payload;
    if (!requestId || !deviceId || action !== "agent.run" && action !== "agent.approve" || !isObject(payload)) {
      safeSend(socket, { type: "remote.error", error: "\u4EFB\u52A1\u53C2\u6570\u4E0D\u6B63\u786E" });
      return;
    }
    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > 48 * 1024) {
      safeSend(socket, { type: "remote.error", error: "\u4EFB\u52A1\u5185\u5BB9\u8FC7\u5927" });
      return;
    }
    const existing = await this.commandByRequest(attachment.userId, requestId);
    if (existing) {
      safeSend(socket, { type: "command.accepted", command: commandFromRow(existing) });
      return;
    }
    const agents = this.ctx.getWebSockets(`device:${deviceId}`).filter((candidate) => candidate.readyState === WebSocket.OPEN);
    if (agents.length === 0) {
      safeSend(socket, { type: "remote.error", error: "\u76EE\u6807\u7535\u8111\u5F53\u524D\u4E0D\u5728\u7EBF" });
      return;
    }
    const device = await this.env.DB.prepare(
      "SELECT id FROM devices WHERE user_id = ? AND id = ?"
    ).bind(attachment.userId, deviceId).first();
    if (!device) {
      safeSend(socket, { type: "remote.error", error: "\u627E\u4E0D\u5230\u76EE\u6807\u7535\u8111" });
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
    const row = {
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
  async commandByRequest(userId, requestId) {
    return this.env.DB.prepare(`
      SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
        FROM commands WHERE user_id = ? AND request_id = ?
    `).bind(userId, requestId).first();
  }
  async updateCommand(socket, attachment, message) {
    const value = message.command;
    if (!isObject(value)) {
      safeSend(socket, { type: "remote.error", error: "\u4EFB\u52A1\u72B6\u6001\u683C\u5F0F\u4E0D\u6B63\u786E" });
      return;
    }
    const id = stringField(value.id, 128);
    const status = value.status;
    const allowedStatus = status === "queued" || status === "running" || status === "awaiting_approval" || status === "completed" || status === "failed";
    if (!id || !allowedStatus) {
      safeSend(socket, { type: "remote.error", error: "\u4EFB\u52A1\u72B6\u6001\u683C\u5F0F\u4E0D\u6B63\u786E" });
      return;
    }
    const existing = await this.env.DB.prepare(`
      SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
        FROM commands WHERE id = ? AND user_id = ? AND device_id = ?
    `).bind(id, attachment.userId, attachment.deviceId ?? "").first();
    if (!existing) {
      safeSend(socket, { type: "remote.error", error: "\u627E\u4E0D\u5230\u5BF9\u5E94\u4EFB\u52A1" });
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
  async recordEvent(socket, attachment, message) {
    const commandId = stringField(message.commandId, 128);
    const event = message.event;
    if (!commandId || !isObject(event) || typeof event.type !== "string" || event.type.length > 64) {
      safeSend(socket, { type: "remote.error", error: "\u4EFB\u52A1\u4E8B\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E" });
      return;
    }
    const eventJson = JSON.stringify(event);
    if (eventJson.length > 48 * 1024) {
      safeSend(socket, { type: "remote.error", error: "\u4EFB\u52A1\u4E8B\u4EF6\u8FC7\u5927" });
      return;
    }
    const existing = await this.env.DB.prepare(`
      SELECT id, request_id, device_id, action, status, summary, payload_json, created_at, updated_at
        FROM commands WHERE id = ? AND user_id = ? AND device_id = ?
    `).bind(commandId, attachment.userId, attachment.deviceId ?? "").first();
    if (!existing) {
      safeSend(socket, { type: "remote.error", error: "\u627E\u4E0D\u5230\u5BF9\u5E94\u4EFB\u52A1" });
      return;
    }
    const now = Date.now();
    let nextStatus;
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
};

// src/index.ts
async function register(request, env) {
  const body = await readJsonObject(request);
  const input = validateRegistration(body);
  const duplicate = await env.DB.prepare(
    "SELECT email, username FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1"
  ).bind(input.email, input.username).first();
  if (duplicate) throw new HttpError(409, duplicate.email.toLowerCase() === input.email ? "\u8BE5\u90AE\u7BB1\u5DF2\u6CE8\u518C" : "\u8BE5\u7528\u6237\u540D\u5DF2\u88AB\u4F7F\u7528", "account_exists");
  const password = await createPasswordRecord(input.password);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO users (id, email, username, display_name, password_salt, password_hash, password_iterations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, input.email, input.username, input.displayName, password.salt, password.hash, password.iterations, now).run();
  } catch {
    throw new HttpError(409, "\u90AE\u7BB1\u6216\u7528\u6237\u540D\u5DF2\u88AB\u4F7F\u7528", "account_exists");
  }
  const session = await createSession(env.DB, id);
  return json({ ...session, user: { id, email: input.email, username: input.username, displayName: input.displayName } }, 201);
}
__name(register, "register");
async function login(request, env) {
  const body = await readJsonObject(request);
  const identifier = requiredString(body.identifier, "\u90AE\u7BB1\u6216\u7528\u6237\u540D", { max: 254 }).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const row = await env.DB.prepare(`
    SELECT id, email, username, display_name, password_salt, password_hash, password_iterations
      FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1
  `).bind(identifier, identifier).first();
  if (!row || !await verifyPassword(password, row)) throw new HttpError(401, "\u8D26\u53F7\u6216\u5BC6\u7801\u4E0D\u6B63\u786E", "invalid_credentials");
  const session = await createSession(env.DB, row.id);
  return json({ ...session, user: publicUser(row) });
}
__name(login, "login");
async function me(request, env) {
  const auth = await authenticate(request, env.DB);
  return json({ user: auth.user });
}
__name(me, "me");
async function logout(request, env) {
  const auth = await authenticate(request, env.DB);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
  return json({});
}
__name(logout, "logout");
function validAgentDevice(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const device = value;
  return typeof device.id === "string" && device.id.length > 0 && device.id.length <= 128 && typeof device.name === "string" && device.name.length > 0 && device.name.length <= 128 && typeof device.platform === "string" && device.platform.length > 0 && device.platform.length <= 64;
}
__name(validAgentDevice, "validAgentDevice");
async function createTicket(request, env) {
  const auth = await authenticate(request, env.DB);
  const body = await readJsonObject(request);
  const role = body.role === "agent" ? "agent" : body.role === "controller" ? "controller" : void 0;
  if (!role) throw new HttpError(400, "\u8FDC\u7A0B\u89D2\u8272\u4E0D\u6B63\u786E", "invalid_role");
  if (role === "agent" && !validAgentDevice(body.device)) {
    throw new HttpError(400, "Agent \u8FDE\u63A5\u9700\u8981\u5B8C\u6574\u8BBE\u5907\u4FE1\u606F", "invalid_device");
  }
  const metadata = role === "agent" ? { device: body.device } : {};
  const ticket = randomToken();
  const ticketHash = await sha256(ticket);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO remote_tickets (ticket_hash, user_id, role, metadata_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(ticketHash, auth.user.id, role, JSON.stringify(metadata), now + 6e4, now).run();
  const requestUrl = new URL(request.url);
  requestUrl.pathname = "/v1/remote/connect";
  requestUrl.search = new URLSearchParams({ ticket }).toString();
  requestUrl.protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  return json({ url: requestUrl.toString() });
}
__name(createTicket, "createTicket");
async function connect(request, env) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "\u9700\u8981 WebSocket Upgrade \u8BF7\u6C42", code: "upgrade_required" }, 426);
  }
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  if (!ticket || ticket.length > 256) throw new HttpError(401, "\u8FDC\u7A0B\u8FDE\u63A5\u51ED\u8BC1\u65E0\u6548", "invalid_ticket");
  const ticketHash = await sha256(ticket);
  const row = await env.DB.prepare(`
    DELETE FROM remote_tickets
     WHERE ticket_hash = ? AND expires_at > ?
    RETURNING user_id, role, metadata_json
  `).bind(ticketHash, Date.now()).first();
  if (!row) throw new HttpError(401, "\u8FDC\u7A0B\u8FDE\u63A5\u51ED\u8BC1\u5DF2\u5931\u6548", "invalid_ticket");
  let device;
  try {
    const metadata = JSON.parse(row.metadata_json);
    if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
      device = metadata.device;
    }
  } catch {
    device = void 0;
  }
  const headers = new Headers(request.headers);
  headers.set("x-rcode-role", row.role);
  headers.set("x-rcode-user-id", row.user_id);
  if (row.role === "agent") headers.set("x-rcode-device", JSON.stringify(device));
  const room = env.REMOTE_ROOMS.getByName(row.user_id);
  return room.fetch(new Request(request, { headers }));
}
__name(connect, "connect");
async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json({ service: "rcode-remote-server", status: "ok", version: "0.1.0" });
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/register") return register(request, env);
  if (request.method === "POST" && url.pathname === "/v1/auth/login") return login(request, env);
  if (request.method === "GET" && url.pathname === "/v1/auth/me") return me(request, env);
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") return logout(request, env);
  if (request.method === "POST" && url.pathname === "/v1/remote/ticket") return createTicket(request, env);
  if (request.method === "GET" && url.pathname === "/v1/remote/connect") return connect(request, env);
  throw new HttpError(404, "\u63A5\u53E3\u4E0D\u5B58\u5728", "not_found");
}
__name(route, "route");
var index_default = {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
      logError("unhandled request error", error, { requestId, method: request.method, path: new URL(request.url).pathname });
      return json({ error: "\u670D\u52A1\u5668\u6682\u65F6\u4E0D\u53EF\u7528", code: "internal_error", requestId }, 500);
    }
  }
};
export {
  RemoteRoom,
  index_default as default
};
//# sourceMappingURL=index.js.map
