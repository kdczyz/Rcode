import { authenticate, createPasswordRecord, createSession, publicUser, randomToken, sha256, validateRegistration, verifyPassword } from "./auth";
import { corsHeaders, HttpError, json, logError, readJsonObject, requiredString } from "./http";
export { RemoteRoom } from "./remote-room";

interface LoginUserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  created_at: number;
}

interface TicketRow {
  user_id: string;
  role: "controller" | "agent";
  metadata_json: string;
}

async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const input = validateRegistration(body);
  const duplicate = await env.DB.prepare(
    "SELECT email, username FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1"
  ).bind(input.email, input.username).first<{ email: string; username: string }>();
  if (duplicate) throw new HttpError(409, duplicate.email.toLowerCase() === input.email ? "该邮箱已注册" : "该用户名已被使用", "account_exists");

  const password = await createPasswordRecord(input.password);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO users (id, email, username, display_name, password_salt, password_hash, password_iterations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, input.email, input.username, input.displayName, password.salt, password.hash, password.iterations, now).run();
  } catch {
    throw new HttpError(409, "邮箱或用户名已被使用", "account_exists");
  }
  const session = await createSession(env.DB, id);
  return json({
    ...session,
    user: {
      id,
      email: input.email,
      username: input.username,
      displayName: input.displayName,
      createdAt: new Date(now).toISOString()
    }
  }, 201);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const identifier = requiredString(body.identifier, "邮箱或用户名", { max: 254 }).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const row = await env.DB.prepare(`
    SELECT id, email, username, display_name, password_salt, password_hash, password_iterations, created_at
      FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1
  `).bind(identifier, identifier).first<LoginUserRow>();
  if (!row || !(await verifyPassword(password, row))) throw new HttpError(401, "账号或密码不正确", "invalid_credentials");
  const session = await createSession(env.DB, row.id);
  return json({ ...session, user: publicUser(row) });
}

async function me(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env.DB);
  return json({ user: auth.user, expiresAt: auth.expiresAt });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env.DB);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
  return json({});
}

function validAgentDevice(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return typeof device.id === "string" && device.id.length > 0 && device.id.length <= 128
    && typeof device.name === "string" && device.name.length > 0 && device.name.length <= 128
    && typeof device.platform === "string" && device.platform.length > 0 && device.platform.length <= 64;
}

async function createTicket(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env.DB);
  const body = await readJsonObject(request);
  const role = body.role === "agent" ? "agent" : body.role === "controller" ? "controller" : undefined;
  if (!role) throw new HttpError(400, "远程角色不正确", "invalid_role");
  if (role === "agent" && !validAgentDevice(body.device)) {
    throw new HttpError(400, "Agent 连接需要完整设备信息", "invalid_device");
  }
  const metadata = role === "agent" ? { device: body.device } : {};
  const ticket = randomToken();
  const ticketHash = await sha256(ticket);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO remote_tickets (ticket_hash, user_id, role, metadata_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(ticketHash, auth.user.id, role, JSON.stringify(metadata), now + 60_000, now).run();
  const requestUrl = new URL(request.url);
  requestUrl.pathname = "/v1/remote/connect";
  requestUrl.search = new URLSearchParams({ ticket }).toString();
  requestUrl.protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  return json({ url: requestUrl.toString() });
}

async function connect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "需要 WebSocket Upgrade 请求", code: "upgrade_required" }, 426);
  }
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  if (!ticket || ticket.length > 256) throw new HttpError(401, "远程连接凭证无效", "invalid_ticket");
  const ticketHash = await sha256(ticket);
  const row = await env.DB.prepare(`
    DELETE FROM remote_tickets
     WHERE ticket_hash = ? AND expires_at > ?
    RETURNING user_id, role, metadata_json
  `).bind(ticketHash, Date.now()).first<TicketRow>();
  if (!row) throw new HttpError(401, "远程连接凭证已失效", "invalid_ticket");

  let device: unknown;
  try {
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
      device = (metadata as Record<string, unknown>).device;
    }
  } catch { device = undefined; }
  const headers = new Headers(request.headers);
  headers.set("x-rcode-role", row.role);
  headers.set("x-rcode-user-id", row.user_id);
  if (row.role === "agent") headers.set("x-rcode-device", JSON.stringify(device));
  const room = env.REMOTE_ROOMS.getByName(row.user_id);
  return room.fetch(new Request(request, { headers }));
}

async function route(request: Request, env: Env): Promise<Response> {
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
  throw new HttpError(404, "接口不存在", "not_found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
      logError("unhandled request error", error, { requestId, method: request.method, path: new URL(request.url).pathname });
      return json({ error: "服务器暂时不可用", code: "internal_error", requestId }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
