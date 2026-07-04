import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

interface AccountRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  last_login_at: string | null;
}

interface SessionRow {
  token_hash: string;
  user_id: number;
  expires_at: string;
}

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  lastLoginAt?: string;
}

const defaultSessionDays = 30;
const workspaceRoot = process.cwd();
const databasePath = path.resolve(workspaceRoot, process.env.LOCAL_DATABASE_PATH ?? "data/agent-console.sqlite");

let database: DatabaseSync | undefined;

function getDatabase() {
  if (database) return database;
  mkdirSync(path.dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  seedDefaultAccount(database);
  return database;
}

function toAuthUser(row: AccountRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    lastLoginAt: row.last_login_at ?? undefined
  };
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, expectedHash] = storedHash.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHash) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("base64url"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function seedDefaultAccount(db: DatabaseSync) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (existing.count > 0) return;

  const password = process.env.LOCAL_ACCOUNT_PASSWORD;
  if (!password) return;

  const username = process.env.LOCAL_ACCOUNT_USERNAME?.trim() || "local";
  const displayName = process.env.LOCAL_ACCOUNT_DISPLAY_NAME?.trim() || "本机账号";
  db.prepare(`
    INSERT INTO users (username, display_name, password_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(username, displayName, hashPassword(password), new Date().toISOString());
}

export function getLocalAuthStatus() {
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return {
    database: "sqlite",
    configured: count.count > 0,
    databasePath
  };
}

export function authenticateLocalUser(username: string, password: string) {
  const db = getDatabase();
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as AccountRow | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) return undefined;

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + defaultSessionDays);
  const token = randomBytes(32).toString("base64url");

  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now.toISOString(), user.id);
  db.prepare(`
    INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), user.id, now.toISOString(), expiresAt.toISOString());

  return {
    token,
    user: toAuthUser({ ...user, last_login_at: now.toISOString() })
  };
}

export function getLocalSession(token: string | undefined) {
  if (!token) return undefined;
  const db = getDatabase();
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  const session = db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(hashToken(token)) as SessionRow | undefined;
  if (!session) return undefined;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as AccountRow | undefined;
  return user ? toAuthUser(user) : undefined;
}

export function deleteLocalSession(token: string | undefined) {
  if (!token) return;
  getDatabase().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
}
