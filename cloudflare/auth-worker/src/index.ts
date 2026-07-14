const encoder = new TextEncoder();
// workerd enforces a maximum of 100,000 iterations for one PBKDF2 operation.
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 128;
const MAX_BODY_BYTES = 16 * 1024;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const DUMMY_SALT = "cmNvZGUtYXV0aC1kdW1teS1zYWx0";

type UserRow = {
  id: string;
  email: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  status: "active" | "disabled";
  created_at: number;
  last_login_at: number | null;
};

type PublicUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  createdAt: string;
  lastLoginAt?: string;
};

type AttemptRow = {
  attempt_count: number;
  window_started_at: number;
  blocked_until: number | null;
};

type SessionUserRow = UserRow & {
  session_id: string;
  expires_at: number;
};

type RegisterInput = {
  email: string;
  username: string;
  displayName: string;
  password: string;
};

type LoginInput = {
  identifier: string;
  password: string;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly retryAfter?: number
  ) {
    super(message);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const hash = await derivePassword(password, saltBytes, PASSWORD_ITERATIONS);
  return { hash: base64UrlEncode(hash), salt: base64UrlEncode(saltBytes), iterations: PASSWORD_ITERATIONS };
}

async function verifyPassword(password: string, user?: UserRow | null): Promise<boolean> {
  const salt = base64UrlDecode(user?.password_salt ?? DUMMY_SALT);
  const iterations = user?.password_iterations ?? PASSWORD_ITERATIONS;
  const candidate = await derivePassword(password, salt, iterations);
  const expected = user ? base64UrlDecode(user.password_hash) : new Uint8Array(32);
  return crypto.subtle.timingSafeEqual(candidate, expected);
}

function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.display_name,
    createdAt: new Date(user.created_at * 1000).toISOString(),
    ...(user.last_login_at ? { lastLoginAt: new Date(user.last_login_at * 1000).toISOString() } : {})
  };
}

function allowedOrigin(request: Request, env: Env): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  const allowed = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : undefined;
}

function responseHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-max-age", "86400");
    headers.set("vary", "Origin");
  }
  return headers;
}

function json(request: Request, env: Env, value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = responseHeaders(request, env);
  if (extraHeaders) new Headers(extraHeaders).forEach((headerValue, key) => headers.set(key, headerValue));
  return new Response(JSON.stringify(value), { status, headers });
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "请求内容过大", "payload_too_large");
  const text = await request.text();
  if (encoder.encode(text).byteLength > MAX_BODY_BYTES) throw new HttpError(413, "请求内容过大", "payload_too_large");
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求格式不正确", "invalid_json");
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field}不能为空`, "validation_error");
  return value.trim();
}

function validateRegister(body: Record<string, unknown>): RegisterInput {
  const email = requiredString(body.email, "邮箱").toLowerCase();
  const username = requiredString(body.username, "用户名").toLowerCase();
  const displayName = requiredString(body.displayName, "显示名称");
  const password = typeof body.password === "string" ? body.password : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "请输入有效邮箱", "validation_error");
  }
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    throw new HttpError(400, "用户名需为 3–32 位字母、数字、点、横线或下划线", "validation_error");
  }
  if (displayName.length < 2 || displayName.length > 50) {
    throw new HttpError(400, "显示名称需为 2–50 个字符", "validation_error");
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, "密码需为 6–128 位，且同时包含字母和数字", "validation_error");
  }
  return { email, username, displayName, password };
}

function validateLogin(body: Record<string, unknown>): LoginInput {
  const identifier = requiredString(body.identifier, "账号").toLowerCase().slice(0, 254);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, "请输入有效密码", "validation_error");
  }
  return { identifier, password };
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");
  return scheme.toLowerCase() === "bearer" && token ? token : undefined;
}

async function clientAttemptKey(request: Request, identifier: string): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return sha256(`${ip}|${identifier}`);
}

async function ensureNotRateLimited(db: D1Database, key: string, now: number): Promise<void> {
  const attempt = await db.prepare(
    "SELECT attempt_count, window_started_at, blocked_until FROM auth_attempts WHERE key = ?1"
  ).bind(key).first<AttemptRow>();
  if (attempt?.blocked_until && attempt.blocked_until > now) {
    throw new HttpError(429, "登录尝试过多，请稍后再试", "rate_limited", attempt.blocked_until - now);
  }
}

async function recordFailedAttempt(db: D1Database, key: string, now: number): Promise<void> {
  const current = await db.prepare(
    "SELECT attempt_count, window_started_at, blocked_until FROM auth_attempts WHERE key = ?1"
  ).bind(key).first<AttemptRow>();
  const withinWindow = Boolean(current && current.window_started_at >= now - LOGIN_WINDOW_SECONDS);
  const attemptCount = withinWindow ? (current?.attempt_count ?? 0) + 1 : 1;
  const windowStartedAt = withinWindow ? current!.window_started_at : now;
  const blockedUntil = attemptCount >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_WINDOW_SECONDS : null;
  await db.prepare(
    `INSERT INTO auth_attempts (key, attempt_count, window_started_at, blocked_until, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(key) DO UPDATE SET attempt_count = excluded.attempt_count,
       window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until,
       updated_at = excluded.updated_at`
  ).bind(key, attemptCount, windowStartedAt, blockedUntil, now).run();
}

function sessionTtl(env: Env): number {
  const configured = Number(env.SESSION_TTL_SECONDS);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 3600), 60 * 60 * 24 * 90) : 60 * 60 * 24 * 30;
}

async function sessionValues(request: Request, env: Env, userId: string, now: number) {
  const token = randomToken();
  return {
    id: crypto.randomUUID(),
    userId,
    token,
    tokenHash: await sha256(token),
    createdAt: now,
    expiresAt: now + sessionTtl(env),
    userAgentHash: request.headers.get("user-agent") ? await sha256(request.headers.get("user-agent")!) : null
  };
}

async function register(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.ALLOW_REGISTRATION !== "true") throw new HttpError(403, "当前未开放注册", "registration_disabled");
  const input = validateRegister(await readObject(request));
  const now = Math.floor(Date.now() / 1000);
  const attemptKey = await clientAttemptKey(request, "register");
  await ensureNotRateLimited(env.DB, attemptKey, now);
  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?1 OR username = ?2 LIMIT 1"
  ).bind(input.email, input.username).first<{ id: string }>();
  if (existing) {
    await recordFailedAttempt(env.DB, attemptKey, now);
    throw new HttpError(409, "该邮箱或用户名已被使用", "account_exists");
  }

  const password = await hashPassword(input.password);
  const userId = crypto.randomUUID();
  const session = await sessionValues(request, env, userId, now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, username, display_name, password_hash, password_salt,
       password_iterations, created_at, updated_at, last_login_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)`
    ).bind(userId, input.email, input.username, input.displayName, password.hash, password.salt, password.iterations, now),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent_hash)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`
    ).bind(session.id, userId, session.tokenHash, now, session.expiresAt, session.userAgentHash)
  ]);
  ctx.waitUntil(pruneSecurityState(env.DB, now));
  const user: UserRow = {
    id: userId,
    email: input.email,
    username: input.username,
    display_name: input.displayName,
    password_hash: password.hash,
    password_salt: password.salt,
    password_iterations: password.iterations,
    status: "active",
    created_at: now,
    last_login_at: now
  };
  return json(request, env, { user: publicUser(user), token: session.token, expiresAt: new Date(session.expiresAt * 1000).toISOString() }, 201);
}

async function login(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const input = validateLogin(await readObject(request));
  const now = Math.floor(Date.now() / 1000);
  const attemptKey = await clientAttemptKey(request, input.identifier);
  await ensureNotRateLimited(env.DB, attemptKey, now);
  const user = await env.DB.prepare(
    `SELECT id, email, username, display_name, password_hash, password_salt, password_iterations,
     status, created_at, last_login_at FROM users WHERE email = ?1 OR username = ?1 LIMIT 1`
  ).bind(input.identifier).first<UserRow>();
  const validPassword = await verifyPassword(input.password, user);
  if (!user || !validPassword || user.status !== "active") {
    await recordFailedAttempt(env.DB, attemptKey, now);
    throw new HttpError(401, "账号或密码不正确", "invalid_credentials");
  }

  const session = await sessionValues(request, env, user.id, now);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET last_login_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now, user.id),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent_hash)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`
    ).bind(session.id, user.id, session.tokenHash, now, session.expiresAt, session.userAgentHash),
    env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(attemptKey)
  ]);
  ctx.waitUntil(pruneSecurityState(env.DB, now));
  return json(request, env, {
    user: publicUser({ ...user, last_login_at: now }),
    token: session.token,
    expiresAt: new Date(session.expiresAt * 1000).toISOString()
  });
}

async function authenticatedUser(request: Request, env: Env): Promise<SessionUserRow> {
  const token = bearerToken(request);
  if (!token || token.length > 128) throw new HttpError(401, "请先登录", "unauthorized");
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.username, u.display_name, u.password_hash, u.password_salt,
     u.password_iterations, u.status, u.created_at, u.last_login_at,
     s.id AS session_id, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 LIMIT 1`
  ).bind(tokenHash, now).first<SessionUserRow>();
  if (!row || row.status !== "active") throw new HttpError(401, "登录已失效，请重新登录", "unauthorized");
  return row;
}

async function me(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await authenticatedUser(request, env);
  const now = Math.floor(Date.now() / 1000);
  ctx.waitUntil(env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2").bind(now, user.session_id).run());
  return json(request, env, { user: publicUser(user), expiresAt: new Date(user.expires_at * 1000).toISOString() });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (token && token.length <= 128) {
    const tokenHash = await sha256(token);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL").bind(now, tokenHash).run();
  }
  return json(request, env, { ok: true });
}

async function pruneSecurityState(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1 OR (revoked_at IS NOT NULL AND revoked_at <= ?2)").bind(now, now - 7 * 86400),
    db.prepare("DELETE FROM auth_attempts WHERE updated_at <= ?1").bind(now - 86400)
  ]);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.has("origin") && !allowedOrigin(request, env)) {
    throw new HttpError(403, "不允许的请求来源", "origin_not_allowed");
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request, env) });
  if (request.method === "GET" && url.pathname === "/health") {
    return json(request, env, { ok: true, service: "rcode-auth", version: "1" });
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/register") return register(request, env, ctx);
  if (request.method === "POST" && url.pathname === "/v1/auth/login") return login(request, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/auth/me") return me(request, env, ctx);
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") return logout(request, env);
  throw new HttpError(404, "接口不存在", "not_found");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          request,
          env,
          { error: error.message, code: error.code },
          error.status,
          error.retryAfter ? { "retry-after": String(error.retryAfter) } : undefined
        );
      }
      console.error(JSON.stringify({
        message: "auth request failed",
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error)
      }));
      return json(request, env, { error: "服务器暂时不可用", code: "internal_error" }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
