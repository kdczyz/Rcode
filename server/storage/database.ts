import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAttachment, AgentMessage, LearningRunStatus, PendingApproval, PermissionRule, ToolCall, ToolResult } from "../shared/types";

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
  attachments_json: string | null;
}

type UsageEventType = "prompt" | "ai_call";

export interface AgentUsageEventInput {
  eventType: UsageEventType;
  projectPath?: string;
  conversationId?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  rawInputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  sessionWasExisting?: boolean;
}

export interface AgentUsageSummary {
  totals: {
    rawInputTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    realTotalTokens: number;
    cacheHitRate: number;
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
    rawInputTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
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

export type LearningRecordCategory = "preference" | "project" | "pattern" | "bugfix" | "workflow";

export interface LearningRecordInput {
  projectPath: string;
  conversationId?: string;
  title: string;
  insight: string;
  category?: LearningRecordCategory;
  evidence?: string;
  importance?: number;
  dedupeKey?: string;
  source?: "agent" | "automatic" | "manual";
  confidence?: number;
}

export interface LearningRecord {
  id: string;
  projectPath: string;
  conversationId?: string;
  title: string;
  insight: string;
  category: LearningRecordCategory;
  evidence?: string;
  importance: number;
  dedupeKey?: string;
  source: "agent" | "automatic" | "manual";
  confidence: number;
  confirmationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearningRun {
  id: string;
  projectPath: string;
  conversationId?: string;
  status: LearningRunStatus;
  reason: string;
  recordsSaved: number;
  createdAt: string;
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
  bearerTokenEnvVar?: string;
  oauthClientId?: string;
  enabled: boolean;
  defaultApproval: "allow" | "ask" | "deny";
  instructions?: string;
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; enabled?: boolean; approvalMode?: "allow" | "ask" | "deny" }>;
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
  balancePath?: string;
  defaultModel: string;
  fallbackModels?: string[];
  enabled: boolean;
  source?: "builtin" | "user";
}

const workspaceRoot = process.cwd();
const databasePath = path.resolve(workspaceRoot, process.env.LOCAL_DATABASE_PATH ?? "data/agent-console.sqlite");

let database: DatabaseSync | undefined;

function getDatabase() {
  if (database) return database;
  mkdirSync(path.dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
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
      attachments_json TEXT,
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
    CREATE TABLE IF NOT EXISTS learning_records (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT NOT NULL,
      insight TEXT NOT NULL,
      category TEXT NOT NULL,
      evidence TEXT,
      importance INTEGER NOT NULL DEFAULT 2,
      fingerprint TEXT NOT NULL,
      dedupe_key TEXT,
      source TEXT NOT NULL DEFAULT 'agent',
      confidence REAL NOT NULL DEFAULT 1,
      confirmation_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS learning_records_project_fingerprint
      ON learning_records(project_path, fingerprint);
    CREATE TABLE IF NOT EXISTS learning_runs (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      conversation_id TEXT,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      records_saved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
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
      raw_input_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      input_token_semantics INTEGER NOT NULL DEFAULT 1,
      session_was_existing INTEGER
    );
  `);
  migrateDatabase(database);
  const githubPreset: McpServerConfig = {
    id: "github",
    name: "GitHub",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    bearerTokenEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
    enabled: false,
    defaultApproval: "ask",
    instructions: "GitHub 官方远程 MCP。启用前请在 .env.local 中配置 GITHUB_PERSONAL_ACCESS_TOKEN。",
    tools: []
  };
  database.prepare(`
    INSERT OR IGNORE INTO mcp_servers (id, name, config_json, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    githubPreset.id,
    githubPreset.name,
    JSON.stringify(githubPreset),
    0,
    new Date().toISOString()
  );
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
  tryExec(db, "DROP TABLE IF EXISTS auth_sessions");
  tryExec(db, "DROP TABLE IF EXISTS users");
  tryExec(db, "ALTER TABLE approvals ADD COLUMN remaining_tool_queue_json TEXT");
  tryExec(db, "ALTER TABLE messages ADD COLUMN attachments_json TEXT");
  tryExec(db, "ALTER TABLE approvals ADD COLUMN resume_input_json TEXT");
  tryExec(db, "ALTER TABLE approvals ADD COLUMN conversation_snapshot_id TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN executor_kind TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN cwd TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN argv_json TEXT");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN network_risk INTEGER");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN outside_workspace_risk INTEGER");
  tryExec(db, "ALTER TABLE audit_events ADD COLUMN artifact_ids_json TEXT");
  tryExec(db, "ALTER TABLE learning_records ADD COLUMN dedupe_key TEXT");
  tryExec(db, "ALTER TABLE learning_records ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'");
  tryExec(db, "ALTER TABLE learning_records ADD COLUMN confidence REAL NOT NULL DEFAULT 1");
  tryExec(db, "ALTER TABLE learning_records ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 1");
  tryExec(db, "ALTER TABLE agent_usage_events ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  tryExec(db, "ALTER TABLE agent_usage_events ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
  tryExec(db, "ALTER TABLE agent_usage_events ADD COLUMN raw_input_tokens INTEGER NOT NULL DEFAULT 0");
  tryExec(db, "ALTER TABLE agent_usage_events ADD COLUMN input_token_semantics INTEGER NOT NULL DEFAULT 0");
  tryExec(db, "UPDATE agent_usage_events SET cache_read_tokens = cached_tokens WHERE cache_read_tokens = 0 AND cached_tokens > 0");
  tryExec(db, `
    UPDATE agent_usage_events
    SET raw_input_tokens = prompt_tokens,
        prompt_tokens = CASE
          WHEN prompt_tokens >= cache_read_tokens + cache_creation_tokens
          THEN prompt_tokens - cache_read_tokens - cache_creation_tokens
          ELSE prompt_tokens
        END,
        total_tokens = CASE
          WHEN prompt_tokens >= cache_read_tokens + cache_creation_tokens
          THEN prompt_tokens - cache_read_tokens - cache_creation_tokens
               + completion_tokens + cache_read_tokens + cache_creation_tokens
          ELSE prompt_tokens + completion_tokens + cache_read_tokens + cache_creation_tokens
        END,
        input_token_semantics = 1
    WHERE input_token_semantics = 0
  `);
  tryExec(db, "CREATE UNIQUE INDEX IF NOT EXISTS learning_records_project_dedupe_key ON learning_records(project_path, dedupe_key) WHERE dedupe_key IS NOT NULL");
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
    SELECT role, content, tool_call_id, tool_calls_json, attachments_json
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
      toolCalls: jsonParse<ToolCall[] | undefined>(message.tool_calls_json, undefined),
      attachments: jsonParse<AgentAttachment[] | undefined>(message.attachments_json, undefined)
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
    INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_calls_json, attachments_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    message.role,
    message.content,
    message.toolCallId ?? null,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    message.attachments ? JSON.stringify(message.attachments) : null,
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
      model, provider, raw_input_tokens, prompt_tokens, completion_tokens, total_tokens,
      cached_tokens, cache_read_tokens, cache_creation_tokens, input_token_semantics,
      session_was_existing
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    createdAt,
    event.eventType,
    event.projectPath ?? null,
    event.conversationId ?? null,
    event.requestId ?? null,
    event.model ?? null,
    event.provider ?? null,
    toSafeInteger(event.rawInputTokens ?? event.promptTokens),
    toSafeInteger(event.promptTokens),
    toSafeInteger(event.completionTokens),
    toSafeInteger(event.totalTokens),
    toSafeInteger(event.cacheReadTokens ?? event.cachedTokens),
    toSafeInteger(event.cacheReadTokens ?? event.cachedTokens),
    toSafeInteger(event.cacheCreationTokens),
    1,
    typeof event.sessionWasExisting === "boolean" ? (event.sessionWasExisting ? 1 : 0) : null
  );
  return id;
}

export function getAgentUsageSummary(): AgentUsageSummary {
  const db = getDatabase();
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(raw_input_tokens), 0) AS rawInputTokens,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(CASE WHEN event_type = 'ai_call' THEN 1 ELSE 0 END), 0) AS aiCalls
    FROM agent_usage_events
  `).get() as {
    rawInputTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    aiCalls: number;
  };
  const cacheableInput = totals.promptTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  const realTotalTokens = totals.promptTokens + totals.completionTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
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
    raw_input_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    input_token_semantics: number;
    session_was_existing: number | null;
  }>;

  return {
    totals: {
      rawInputTokens: totals.rawInputTokens,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: realTotalTokens,
      cachedTokens: totals.cacheReadTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      realTotalTokens,
      cacheHitRate: cacheableInput > 0 ? totals.cacheReadTokens / cacheableInput : 0
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
      rawInputTokens: row.raw_input_tokens,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      cachedTokens: row.cached_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
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

const learningCategories = new Set<LearningRecordCategory>(["preference", "project", "pattern", "bugfix", "workflow"]);

function normalizeLearningText(value: string, maxLength: number) {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function learningFingerprint(title: string, insight: string) {
  const normalized = `${title}\n${insight}`.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function normalizeLearningDedupeKey(value: string | undefined) {
  if (!value) return "";
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function assertSafeLearningContent(content: string) {
  const secretPattern = /(?:\bsk-[a-z0-9_-]{12,}|\bapi[_ -]?key\s*[:=]|\bauthorization\s*:\s*bearer|\bpassword\s*[:=]|\bcookie\s*:)/i;
  if (secretPattern.test(content)) throw new Error("Learning records cannot contain credentials or authentication data");
}

function mapLearningRecord(row: Record<string, unknown>): LearningRecord {
  return {
    id: String(row.id),
    projectPath: String(row.project_path),
    conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
    title: String(row.title),
    insight: String(row.insight),
    category: String(row.category) as LearningRecordCategory,
    evidence: row.evidence ? String(row.evidence) : undefined,
    importance: Number(row.importance),
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : undefined,
    source: (row.source ? String(row.source) : "agent") as LearningRecord["source"],
    confidence: Number(row.confidence ?? 1),
    confirmationCount: Number(row.confirmation_count ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function listLearningRecords(projectPath: string, limit = 100): LearningRecord[] {
  const rows = getDatabase().prepare(`
    SELECT id, project_path, conversation_id, title, insight, category, evidence, importance,
           dedupe_key, source, confidence, confirmation_count, created_at, updated_at
    FROM learning_records
    WHERE project_path = ?
    ORDER BY importance DESC, updated_at DESC
    LIMIT ?
  `).all(projectPath, Math.max(1, Math.min(limit, 500))) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapLearningRecord);
}

export function saveLearningRecord(input: LearningRecordInput): LearningRecord {
  const projectPath = input.projectPath.trim();
  const title = normalizeLearningText(input.title, 120);
  const insight = normalizeLearningText(input.insight, 1200);
  const evidence = input.evidence ? normalizeLearningText(input.evidence, 600) : "";
  if (!projectPath || !title || !insight) throw new Error("projectPath, title, and insight are required");
  assertSafeLearningContent(`${title}\n${insight}\n${evidence}`);
  const category = input.category && learningCategories.has(input.category) ? input.category : "pattern";
  const importance = Math.max(1, Math.min(5, Math.round(input.importance ?? 2)));
  const dedupeKey = normalizeLearningDedupeKey(input.dedupeKey);
  const source = input.source === "automatic" || input.source === "manual" ? input.source : "agent";
  const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence! : 1));
  const fingerprint = learningFingerprint(title, insight);
  const db = getDatabase();
  const existing = dedupeKey
    ? db.prepare(`
        SELECT id FROM learning_records
        WHERE project_path = ? AND (dedupe_key = ? OR fingerprint = ?)
      `).get(projectPath, dedupeKey, fingerprint) as { id: string } | undefined
    : db.prepare(`
        SELECT id FROM learning_records WHERE project_path = ? AND fingerprint = ?
      `).get(projectPath, fingerprint) as { id: string } | undefined;
  const now = new Date().toISOString();
  const id = existing?.id ?? createId("learning");
  if (existing) {
    db.prepare(`
      UPDATE learning_records
      SET conversation_id = COALESCE(?, conversation_id), title = ?, insight = ?, category = ?,
          evidence = ?, importance = MAX(importance, ?), dedupe_key = COALESCE(?, dedupe_key),
          source = ?, confidence = MAX(confidence, ?), confirmation_count = confirmation_count + 1,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.conversationId ?? null,
      title,
      insight,
      category,
      evidence || null,
      importance,
      dedupeKey || null,
      source,
      confidence,
      now,
      id
    );
  } else {
    db.prepare(`
      INSERT INTO learning_records
        (id, project_path, conversation_id, title, insight, category, evidence, importance,
         fingerprint, dedupe_key, source, confidence, confirmation_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      projectPath,
      input.conversationId ?? null,
      title,
      insight,
      category,
      evidence || null,
      importance,
      fingerprint,
      dedupeKey || null,
      source,
      confidence,
      now,
      now
    );
  }
  const row = db.prepare(`
    SELECT id, project_path, conversation_id, title, insight, category, evidence, importance,
           dedupe_key, source, confidence, confirmation_count, created_at, updated_at
    FROM learning_records WHERE id = ?
  `).get(id) as unknown as Record<string, unknown>;
  return mapLearningRecord(row);
}

export function deleteLearningRecord(id: string) {
  getDatabase().prepare("DELETE FROM learning_records WHERE id = ?").run(id);
}

export function recordLearningRun(input: {
  projectPath: string;
  conversationId?: string;
  status: LearningRunStatus;
  reason: string;
  recordsSaved?: number;
}): LearningRun {
  const run: LearningRun = {
    id: createId("learning_run"),
    projectPath: input.projectPath,
    conversationId: input.conversationId,
    status: input.status,
    reason: normalizeLearningText(input.reason, 400),
    recordsSaved: Math.max(0, Math.round(input.recordsSaved ?? 0)),
    createdAt: new Date().toISOString()
  };
  getDatabase().prepare(`
    INSERT INTO learning_runs (id, project_path, conversation_id, status, reason, records_saved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.projectPath,
    run.conversationId ?? null,
    run.status,
    run.reason,
    run.recordsSaved,
    run.createdAt
  );
  return run;
}

export function getLatestLearningRun(projectPath: string): LearningRun | undefined {
  const row = getDatabase().prepare(`
    SELECT id, project_path, conversation_id, status, reason, records_saved, created_at
    FROM learning_runs
    WHERE project_path = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectPath) as {
    id: string;
    project_path: string;
    conversation_id: string | null;
    status: LearningRunStatus;
    reason: string;
    records_saved: number;
    created_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    projectPath: row.project_path,
    conversationId: row.conversation_id ?? undefined,
    status: row.status,
    reason: row.reason,
    recordsSaved: row.records_saved,
    createdAt: row.created_at
  };
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
