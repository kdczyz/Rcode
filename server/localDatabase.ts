import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage, PendingApproval, PermissionRule, ToolCall, ToolResult } from "./types";

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

interface ConversationRow {
  id: string;
  project_path: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  role: AgentMessage["role"];
  content: string;
  tool_call_id: string | null;
  tool_calls_json: string | null;
}

type UsageEventType = "prompt" | "ai_call";

export interface AgentUsageEventInput {
  eventType: UsageEventType;
  projectPath?: string;
  conversationId?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  sessionWasExisting?: boolean;
}

export interface AgentUsageSummary {
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
  };
  prompts: {
    total: number;
    sessionHits: number;
    hitRate: number;
  };
  aiCalls: number;
  byModel: Array<{
    model: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  }>;
  daily: Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  }>;
  recent: Array<{
    id: string;
    createdAt: string;
    eventType: UsageEventType;
    projectPath?: string;
    conversationId?: string;
    model?: string;
    provider?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    sessionWasExisting?: boolean;
  }>;
}

export interface StoredConversation {
  id: string;
  projectPath: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  pendingApprovals: PendingApproval[];
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  projectPath?: string;
  conversationId?: string;
  toolCallId?: string;
  toolName?: string;
  permissionEffect?: string;
  permissionReason?: string;
  sandboxPolicy?: string;
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
  input?: unknown;
  outputSummary?: string;
  executorKind?: string;
  cwd?: string;
  argv?: string[];
  networkRisk?: boolean;
  outsideWorkspaceRisk?: boolean;
  artifactIds?: string[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  defaultApproval: "allow" | "ask" | "deny";
  instructions?: string;
  tools?: Array<{ name: string; description?: string; enabled?: boolean; approvalMode?: "allow" | "ask" | "deny" }>;
}

export interface AiProviderConfig {
  id: string;
  displayName: string;
  type: "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  chatCompletionsPath?: string;
  modelsPath?: string;
  defaultModel: string;
  fallbackModels?: string[];
  enabled: boolean;
  source?: "builtin" | "user";
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
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      project_path TEXT,
      tool_call_json TEXT NOT NULL,
      risk TEXT NOT NULL,
      reason TEXT NOT NULL,
      remaining_tool_queue_json TEXT,
      resume_input_json TEXT,
      conversation_snapshot_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      project_path TEXT,
      conversation_id TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      permission_effect TEXT,
      permission_reason TEXT,
      sandbox_policy TEXT,
      ok INTEGER,
      exit_code INTEGER,
      duration_ms INTEGER,
      input_json TEXT,
      output_summary TEXT,
      executor_kind TEXT,
      cwd TEXT,
      argv_json TEXT,
      network_risk INTEGER,
      outside_workspace_risk INTEGER,
      artifact_ids_json TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id TEXT PRIMARY KEY,
      effect TEXT NOT NULL,
      target_type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      scope TEXT NOT NULL,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_usage_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_path TEXT,
      conversation_id TEXT,
      request_id TEXT,
      model TEXT,
      provider TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      session_was_existing INTEGER
    );
  `);
  migrateDatabase(database);
  seedDefaultAccount(database);
  return database;
}

function tryExec(db: DatabaseSync, sql: string) {
  try {
    db.exec(sql);
  } catch {
    // Existing SQLite databases may already have these columns.
  }
}

function migrateDatabase(db: DatabaseSync) {
  tryExec(db, "ALTER TABLE approvals ADD COLUMN remaining_tool_queue_json TEXT");
  tryExec(db, "ALTER TABLE approvals ADD COLUMN resume_input_json TEXT");
  tryExec(db, "ALTER TABLE approvals ADD COLUMN conversation_snapshot_id TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN executor_kind TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN cwd TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN argv_json TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN network_risk INTEGER");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN outside_workspace_risk INTEGER");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN artifact_ids_json TEXT");
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

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function createId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function getOrCreateConversation(input: {
  conversationId?: string;
  projectPath: string;
  title?: string;
}): StoredConversation {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = input.conversationId
    ? db.prepare("SELECT * FROM conversations WHERE id = ? AND project_path = ?").get(input.conversationId, input.projectPath) as ConversationRow | undefined
    : undefined;
  const row = existing ?? {
    id: input.conversationId ?? createId("conversation"),
    project_path: input.projectPath,
    title: input.title ?? null,
    created_at: now,
    updated_at: now
  };

  if (!existing) {
    db.prepare(`
      INSERT INTO conversations (id, project_path, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, row.project_path, row.title, row.created_at, row.updated_at);
  }

  const messageRows = db.prepare(`
    SELECT role, content, tool_call_id, tool_calls_json
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(row.id) as unknown as MessageRow[];
  const approvals = db.prepare("SELECT * FROM approvals WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(row.id) as Array<{
      id: string;
      conversation_id: string;
      project_path: string | null;
      tool_call_json: string;
      risk: PendingApproval["risk"];
      reason: string;
      remaining_tool_queue_json: string | null;
      resume_input_json: string | null;
      conversation_snapshot_id: string | null;
      created_at: string;
    }>;

  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: messageRows.map((message) => ({
      role: message.role,
      content: message.content,
      toolCallId: message.tool_call_id ?? undefined,
      toolCalls: jsonParse<ToolCall[] | undefined>(message.tool_calls_json, undefined)
    })),
    pendingApprovals: approvals.map((approval) => ({
      id: approval.id,
      conversationId: approval.conversation_id,
      projectPath: approval.project_path ?? undefined,
      toolCall: jsonParse<ToolCall>(approval.tool_call_json, { id: "", name: "read_file", arguments: {} }),
      risk: approval.risk,
      reason: approval.reason,
      createdAt: approval.created_at,
      remainingToolQueue: jsonParse<ToolCall[] | undefined>(approval.remaining_tool_queue_json, undefined),
      resumeInput: jsonParse<PendingApproval["resumeInput"] | undefined>(approval.resume_input_json, undefined),
      conversationSnapshotId: approval.conversation_snapshot_id ?? undefined
    }))
  };
}

export function listConversations(projectPath?: string) {
  const db = getDatabase();
  const rows = projectPath
    ? db.prepare("SELECT * FROM conversations WHERE project_path = ? ORDER BY updated_at DESC").all(projectPath)
    : db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all();
  return (rows as unknown as ConversationRow[]).map((row) => ({
    id: row.id,
    projectPath: row.project_path,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function getConversationById(conversationId: string): StoredConversation | undefined {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
  if (!row) return undefined;
  return getOrCreateConversation({ conversationId: row.id, projectPath: row.project_path });
}

export function appendConversationMessage(conversationId: string, message: AgentMessage) {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_calls_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    message.role,
    message.content,
    message.toolCallId ?? null,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    now
  );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
}

export function savePendingApproval(approval: PendingApproval) {
  getDatabase().prepare(`
    INSERT OR REPLACE INTO approvals (
      id, conversation_id, project_path, tool_call_json, risk, reason,
      remaining_tool_queue_json, resume_input_json, conversation_snapshot_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    approval.id,
    approval.conversationId,
    approval.projectPath ?? null,
    JSON.stringify(approval.toolCall),
    approval.risk,
    approval.reason,
    approval.remainingToolQueue ? JSON.stringify(approval.remainingToolQueue) : null,
    approval.resumeInput ? JSON.stringify(approval.resumeInput) : null,
    approval.conversationSnapshotId ?? null,
    approval.createdAt
  );
}

export function deletePendingApproval(approvalId: string) {
  getDatabase().prepare("DELETE FROM approvals WHERE id = ?").run(approvalId);
}

export function getPendingApprovalById(approvalId: string): PendingApproval | undefined {
  const row = getDatabase().prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as {
    id: string;
    conversation_id: string;
    project_path: string | null;
    tool_call_json: string;
    risk: PendingApproval["risk"];
    reason: string;
    remaining_tool_queue_json: string | null;
    resume_input_json: string | null;
    conversation_snapshot_id: string | null;
    created_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectPath: row.project_path ?? undefined,
    toolCall: jsonParse<ToolCall>(row.tool_call_json, { id: "", name: "read_file", arguments: {} }),
    risk: row.risk,
    reason: row.reason,
    createdAt: row.created_at,
    remainingToolQueue: jsonParse<ToolCall[] | undefined>(row.remaining_tool_queue_json, undefined),
    resumeInput: jsonParse<PendingApproval["resumeInput"] | undefined>(row.resume_input_json, undefined),
    conversationSnapshotId: row.conversation_snapshot_id ?? undefined
  };
}

export function recordAuditEvent(event: Omit<AuditEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }) {
  const id = event.id ?? createId("audit");
  const createdAt = event.createdAt ?? new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO audit_events (
      id, created_at, project_path, conversation_id, tool_call_id, tool_name,
      permission_effect, permission_reason, sandbox_policy, ok, exit_code,
      duration_ms, input_json, output_summary, executor_kind, cwd, argv_json,
      network_risk, outside_workspace_risk, artifact_ids_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    createdAt,
    event.projectPath ?? null,
    event.conversationId ?? null,
    event.toolCallId ?? null,
    event.toolName ?? null,
    event.permissionEffect ?? null,
    event.permissionReason ?? null,
    event.sandboxPolicy ?? null,
    typeof event.ok === "boolean" ? (event.ok ? 1 : 0) : null,
    event.exitCode ?? null,
    event.durationMs ?? null,
    event.input === undefined ? null : JSON.stringify(event.input),
    event.outputSummary ?? null,
    event.executorKind ?? null,
    event.cwd ?? null,
    event.argv ? JSON.stringify(event.argv) : null,
    typeof event.networkRisk === "boolean" ? (event.networkRisk ? 1 : 0) : null,
    typeof event.outsideWorkspaceRisk === "boolean" ? (event.outsideWorkspaceRisk ? 1 : 0) : null,
    event.artifactIds ? JSON.stringify(event.artifactIds) : null
  );
  return id;
}

export function listAuditEvents(limit = 100) {
  const rows = getDatabase().prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{
    id: string;
    created_at: string;
    project_path: string | null;
    conversation_id: string | null;
    tool_call_id: string | null;
    tool_name: string | null;
    permission_effect: string | null;
    permission_reason: string | null;
    sandbox_policy: string | null;
    ok: number | null;
    exit_code: number | null;
    duration_ms: number | null;
    input_json: string | null;
    output_summary: string | null;
    executor_kind: string | null;
    cwd: string | null;
    argv_json: string | null;
    network_risk: number | null;
    outside_workspace_risk: number | null;
    artifact_ids_json: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    projectPath: row.project_path ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    permissionEffect: row.permission_effect ?? undefined,
    permissionReason: row.permission_reason ?? undefined,
    sandboxPolicy: row.sandbox_policy ?? undefined,
    ok: row.ok === null ? undefined : row.ok === 1,
    exitCode: row.exit_code ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    input: jsonParse<unknown>(row.input_json, undefined),
    outputSummary: row.output_summary ?? undefined,
    executorKind: row.executor_kind ?? undefined,
    cwd: row.cwd ?? undefined,
    argv: jsonParse<string[] | undefined>(row.argv_json, undefined),
    networkRisk: row.network_risk === null ? undefined : row.network_risk === 1,
    outsideWorkspaceRisk: row.outside_workspace_risk === null ? undefined : row.outside_workspace_risk === 1,
    artifactIds: jsonParse<string[] | undefined>(row.artifact_ids_json, undefined)
  }));
}

function toSafeInteger(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

export function recordAgentUsageEvent(event: AgentUsageEventInput) {
  const id = createId("usage");
  const createdAt = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO agent_usage_events (
      id, created_at, event_type, project_path, conversation_id, request_id,
      model, provider, prompt_tokens, completion_tokens, total_tokens,
      cached_tokens, session_was_existing
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    createdAt,
    event.eventType,
    event.projectPath ?? null,
    event.conversationId ?? null,
    event.requestId ?? null,
    event.model ?? null,
    event.provider ?? null,
    toSafeInteger(event.promptTokens),
    toSafeInteger(event.completionTokens),
    toSafeInteger(event.totalTokens),
    toSafeInteger(event.cachedTokens),
    typeof event.sessionWasExisting === "boolean" ? (event.sessionWasExisting ? 1 : 0) : null
  );
  return id;
}

export function getAgentUsageSummary(): AgentUsageSummary {
  const db = getDatabase();
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
      COALESCE(SUM(CASE WHEN event_type = 'ai_call' THEN 1 ELSE 0 END), 0) AS aiCalls
    FROM agent_usage_events
  `).get() as {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    aiCalls: number;
  };
  const prompts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN session_was_existing = 1 THEN 1 ELSE 0 END), 0) AS sessionHits
    FROM agent_usage_events
    WHERE event_type = 'prompt'
  `).get() as { total: number; sessionHits: number };
  const byModel = db.prepare(`
    SELECT
      COALESCE(model, '未记录模型') AS model,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COUNT(*) AS calls
    FROM agent_usage_events
    WHERE event_type = 'ai_call'
    GROUP BY COALESCE(model, '未记录模型')
    ORDER BY totalTokens DESC, calls DESC
    LIMIT 6
  `).all() as Array<{
    model: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  }>;
  const dailyRows = db.prepare(`
    SELECT
      substr(created_at, 1, 10) AS date,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COUNT(*) AS calls
    FROM agent_usage_events
    WHERE event_type = 'ai_call'
    GROUP BY substr(created_at, 1, 10)
    ORDER BY date ASC
  `).all() as Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  }>;
  const recentRows = db.prepare(`
    SELECT *
    FROM agent_usage_events
    ORDER BY created_at DESC
    LIMIT 12
  `).all() as Array<{
    id: string;
    created_at: string;
    event_type: UsageEventType;
    project_path: string | null;
    conversation_id: string | null;
    model: string | null;
    provider: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    session_was_existing: number | null;
  }>;

  return {
    totals: {
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      cachedTokens: totals.cachedTokens
    },
    prompts: {
      total: prompts.total,
      sessionHits: prompts.sessionHits,
      hitRate: prompts.total > 0 ? prompts.sessionHits / prompts.total : 0
    },
    aiCalls: totals.aiCalls,
    byModel,
    daily: dailyRows,
    recent: recentRows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      eventType: row.event_type,
      projectPath: row.project_path ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      model: row.model ?? undefined,
      provider: row.provider ?? undefined,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      cachedTokens: row.cached_tokens,
      sessionWasExisting: row.session_was_existing === null ? undefined : row.session_was_existing === 1
    }))
  };
}

export function listPermissionRules(): PermissionRule[] {
  const rows = getDatabase().prepare("SELECT * FROM permission_rules ORDER BY scope, target_type, pattern").all() as Array<{
    id: string;
    effect: PermissionRule["effect"];
    target_type: PermissionRule["targetType"];
    pattern: string;
    scope: PermissionRule["scope"];
    enabled: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    effect: row.effect,
    targetType: row.target_type,
    pattern: row.pattern,
    scope: row.scope,
    enabled: row.enabled === 1
  }));
}

export function savePermissionRules(rules: PermissionRule[]) {
  const db = getDatabase();
  db.exec("DELETE FROM permission_rules WHERE scope != 'managed'");
  const insert = db.prepare(`
    INSERT OR REPLACE INTO permission_rules (id, effect, target_type, pattern, scope, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const rule of rules) {
    if (rule.scope === "managed") continue;
    insert.run(rule.id, rule.effect, rule.targetType, rule.pattern, rule.scope, rule.enabled ? 1 : 0);
  }
}

export function listMcpServers(): McpServerConfig[] {
  const rows = getDatabase().prepare("SELECT config_json FROM mcp_servers ORDER BY name").all() as Array<{ config_json: string }>;
  return rows.map((row) => jsonParse<McpServerConfig>(row.config_json, {
    id: createId("mcp"),
    name: "Invalid MCP server",
    transport: "stdio",
    enabled: false,
    defaultApproval: "ask"
  }));
}

export function saveMcpServer(config: McpServerConfig) {
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT OR REPLACE INTO mcp_servers (id, name, config_json, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(config.id, config.name, JSON.stringify(config), config.enabled ? 1 : 0, now);
  return config;
}

export function deleteMcpServer(id: string) {
  getDatabase().prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
}

export function listUserAiProviders(): AiProviderConfig[] {
  const rows = getDatabase().prepare("SELECT config_json FROM ai_providers ORDER BY display_name").all() as Array<{ config_json: string }>;
  return rows.map((row) => jsonParse<AiProviderConfig>(row.config_json, {
    id: createId("ai"),
    displayName: "Invalid AI provider",
    type: "openai-compatible",
    baseUrl: "",
    defaultModel: "",
    enabled: false,
    source: "user"
  }));
}

export function getUserAiProvider(id: string): AiProviderConfig | undefined {
  const row = getDatabase().prepare("SELECT config_json FROM ai_providers WHERE id = ?").get(id) as { config_json: string } | undefined;
  return row ? jsonParse<AiProviderConfig | undefined>(row.config_json, undefined) : undefined;
}

export function saveUserAiProvider(config: AiProviderConfig) {
  const now = new Date().toISOString();
  const provider: AiProviderConfig = {
    ...config,
    source: "user",
    enabled: config.enabled !== false,
    type: "openai-compatible",
    displayName: config.displayName.trim() || config.id,
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    defaultModel: config.defaultModel.trim()
  };
  getDatabase().prepare(`
    INSERT OR REPLACE INTO ai_providers (id, display_name, config_json, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(provider.id, provider.displayName, JSON.stringify(provider), provider.enabled ? 1 : 0, now);
  return provider;
}

export function deleteUserAiProvider(id: string) {
  const db = getDatabase();
  db.prepare("DELETE FROM ai_providers WHERE id = ?").run(id);
  if (getActiveAiProviderId() === id) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run("active_ai_provider");
  }
}

export function getActiveAiProviderId(): string | undefined {
  const row = getDatabase().prepare("SELECT value FROM app_settings WHERE key = ?").get("active_ai_provider") as { value: string } | undefined;
  return row?.value || undefined;
}

export function setActiveAiProviderId(id: string | undefined) {
  const db = getDatabase();
  if (!id) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run("active_ai_provider");
    return;
  }
  db.prepare(`
    INSERT OR REPLACE INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run("active_ai_provider", id, new Date().toISOString());
}

export function listMemories(projectPath: string, limit = 12) {
  const rows = getDatabase().prepare(`
    SELECT id, kind, content, importance, created_at, updated_at
    FROM memories
    WHERE project_path = ?
    ORDER BY importance DESC, updated_at DESC
    LIMIT ?
  `).all(projectPath, limit);
  return rows;
}

export function saveMemory(projectPath: string, kind: string, content: string, importance = 1) {
  const now = new Date().toISOString();
  const id = createId("memory");
  getDatabase().prepare(`
    INSERT INTO memories (id, project_path, kind, content, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectPath, kind, content, importance, now, now);
  return id;
}

export function deleteMemory(id: string) {
  getDatabase().prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export function saveArtifact(input: { conversationId?: string; kind: string; label: string; content: string }) {
  const id = createId("artifact");
  getDatabase().prepare(`
    INSERT INTO artifacts (id, conversation_id, kind, label, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.conversationId ?? null, input.kind, input.label, input.content, new Date().toISOString());
  return { id, kind: input.kind, label: input.label };
}

export function getArtifact(id: string) {
  return getDatabase().prepare(`
    SELECT id, conversation_id, kind, label, content, created_at
    FROM artifacts
    WHERE id = ?
  `).get(id);
}
