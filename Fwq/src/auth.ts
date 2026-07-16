import { HttpError, requiredString } from "./http";

// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  created_at: number;
}

interface SessionUserRow extends UserRow {
  expires_at: number;
}

export interface AuthenticatedUser {
  user: PublicUser;
  tokenHash: string;
  expiresAt: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
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

export async function createPasswordRecord(password: string): Promise<{
  salt: string;
  hash: string;
  iterations: number;
}> {
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

export async function verifyPassword(password: string, row: UserRow): Promise<boolean> {
  let expected: Uint8Array;
  let salt: Uint8Array;
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

export function validatePassword(password: unknown): asserts password is string {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new HttpError(400, "密码至少 8 位，并包含字母和数字", "weak_password");
  }
}

export function publicUser(row: Pick<UserRow, "id" | "email" | "username" | "display_name" | "created_at">): PublicUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function createSession(db: D1Database, userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt, now).run();
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export async function authenticate(request: Request, db: D1Database): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "请先登录", "unauthorized");
  const token = authorization.slice(7).trim();
  if (!token || token.length > 256) throw new HttpError(401, "会话无效", "unauthorized");
  const tokenHash = await sha256(token);
  const row = await db.prepare(`
    SELECT u.id, u.email, u.username, u.display_name, u.password_salt, u.password_hash,
           u.password_iterations, u.created_at, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first<SessionUserRow>();
  if (!row) throw new HttpError(401, "会话已失效，请重新登录", "unauthorized");
  return { user: publicUser(row), tokenHash, expiresAt: new Date(row.expires_at).toISOString() };
}

export function validateRegistration(body: Record<string, unknown>): {
  email: string;
  username: string;
  displayName: string;
  password: string;
} {
  const email = requiredString(body.email, "邮箱", { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "邮箱格式不正确", "invalid_email");
  const username = requiredString(body.username, "用户名", { min: 3, max: 32, pattern: /^[A-Za-z0-9_]+$/ }).toLowerCase();
  const displayName = requiredString(body.displayName, "显示名称", { max: 64 });
  validatePassword(body.password);
  return { email, username, displayName, password: body.password };
}

export { randomToken };
