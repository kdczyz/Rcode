import {
  Archive,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownRight,
  FileText,
  Folder,
  FolderOpen,
  History,
  ListFilter,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  Settings,
  SquareChevronLeft,
  SquareChevronRight,
  Send,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import { CSSProperties, Fragment, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAuth } from "./auth/AuthGate";
import { ChatComposer, type ComposerAttachment } from "./components/chat/ChatComposer";
import { ToolCallGroup, type ManagedProcessView } from "./components/chat/ToolCallGroup";
import { TaskPlanCard, type TaskPlanView } from "./components/chat/TaskPlanCard";
import { AppTopBar } from "./components/layout/AppTopBar";
import { ProjectNavigator } from "./components/sidebar/ProjectNavigator";

type PermissionMode = "default" | "plan" | "workspace_write" | "full_access" | "custom";
type ThemePreference = "system" | "dark" | "light";
type ThinkingMode = "fast" | "balanced" | "deep";
type ProjectKind = "empty" | "folder" | "temporary";
type MessageStatus = "completed" | "approval_required" | "error" | "running";
type WorkflowPhase = "preparing" | "planning" | "thinking" | "inspecting" | "executing" | "awaiting_approval" | "plan_ready" | "completed" | "stopped" | "failed";
type ActiveView = "chat" | "settings";
type SettingsSectionId = "profile" | "general" | "usage" | "skills" | "learning" | "ai" | "mcp";
type UsageActivityMode = "daily" | "weekly" | "total";
type AiProviderHealthState = "idle" | "checking" | "healthy" | "unhealthy";

interface ModelCatalog {
  recommendedForAgent?: string[];
  models?: Array<{ id: string }>;
}

interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
}

interface PermissionCatalog {
  defaultMode?: PermissionMode;
  modes?: Array<{ id: PermissionMode; description: string }>;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: ComposerAttachment[];
  status?: MessageStatus;
  isStreaming?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  activeSkills?: string[];
  toolResult?: { ok: boolean; content: string; process?: ManagedProcessView };
  diff?: DiffResult;
  artifactDiffs?: DiffResult[];
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  showResponseMeta?: boolean;
  responseStartedAt?: number;
  responseCompletedAt?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    billedPromptTokens?: number;
    billedCompletionTokens?: number;
    billedTotalTokens?: number;
    model?: string;
    provider?: string;
    estimated?: boolean;
  };
}

interface PendingApproval {
  id: string;
  reason: string;
  risk: "low" | "medium" | "high";
  toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface ProjectSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  conversationId?: string;
  messages: ChatMessage[];
  pendingApprovals: PendingApproval[];
  permissionMode?: PermissionMode;
  workflowPhase?: WorkflowPhase;
  workflowLabel?: string;
  taskPlan?: TaskPlanView;
  contextSnapshot?: {
    budgetTokens: number;
    estimatedTokens: number;
    messageCount: number;
    includedMessageCount: number;
    compactedMessageCount: number;
    projectContextChars: number;
    activeSkills: string[];
  };
}

interface AgentProject {
  id: string;
  name: string;
  kind: ProjectKind;
  path?: string;
  createdAt: string;
  updatedAt: string;
  sessions: ProjectSession[];
}

interface WorkspaceState {
  projects: AgentProject[];
  activeProjectId: string;
  activeSessionId: string;
}

interface UsageSummary {
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
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
  daily?: Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  }>;
  recent: Array<{
    id: string;
    createdAt: string;
    eventType: "prompt" | "ai_call";
    model?: string;
    provider?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    sessionWasExisting?: boolean;
  }>;
}

interface ToolCatalogItem {
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
  source: "builtin" | "mcp";
  defaultApproval: "allow" | "ask" | "deny";
}

interface AuditEvent {
  id: string;
  createdAt: string;
  toolName?: string;
  permissionEffect?: string;
  permissionReason?: string;
  ok?: boolean;
  durationMs?: number;
  outputSummary?: string;
}

interface McpServerConfig {
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

interface AiProviderConfig {
  id: string;
  displayName: string;
  type: "openai-compatible";
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeyPreview?: string;
  chatCompletionsPath?: string;
  modelsPath?: string;
  balancePath?: string;
  defaultModel: string;
  fallbackModels?: string[];
  enabled: boolean;
  source?: "builtin" | "user";
  active: boolean;
  configured: boolean;
}

interface AiProviderQuickConnect {
  label: string;
  mark: string;
  accent: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
  modelsPath: string;
  balancePath?: string;
  chatCompletionsPath: string;
}

interface AiProviderHealth {
  state: AiProviderHealthState;
  checkedAt?: number;
}

interface AiProviderBalance {
  status: "available" | "unlimited" | "unsupported" | "unavailable";
  source?: string;
  balances?: Array<{
    currency: string;
    amount: number;
    grantedAmount?: number;
    toppedUpAmount?: number;
  }>;
  reason?: string;
  error?: string;
  checkedAt?: string;
}

interface AgentSkill {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user" | "builtin";
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
}

interface MemoryItem {
  id: string;
  kind: string;
  content: string;
  importance: number;
}

type LearningCategory = "preference" | "project" | "pattern" | "bugfix" | "workflow";

interface LearningRecordItem {
  id: string;
  projectPath: string;
  conversationId?: string;
  title: string;
  insight: string;
  category: LearningCategory;
  evidence?: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

type LearningRunStatus = "saved" | "no_candidate" | "skipped" | "failed";

interface LearningRunItem {
  id?: string;
  projectPath?: string;
  conversationId?: string;
  status: LearningRunStatus;
  reason: string;
  recordsSaved: number;
  createdAt: string;
}

const learningCategoryLabels: Record<LearningCategory, string> = {
  preference: "偏好",
  project: "项目约定",
  pattern: "可复用模式",
  bugfix: "问题修复",
  workflow: "工作流"
};

const skillScopeLabels: Record<AgentSkill["scope"], string> = {
  builtin: "内置预设",
  user: "用户",
  project: "当前项目"
};

interface SubagentDefinition {
  name: string;
  description: string;
  scope: "project" | "user";
}

interface QueuedPrompt {
  id: string;
  content: string;
  kind?: "prompt" | "guide";
  attachments?: ComposerAttachment[];
}

interface TaskTimerState {
  startedAt?: number;
  elapsedMs: number;
}

/** SSE 流事件 */
interface StreamEvent {
  type: "run_started" | "workflow_state" | "context_snapshot" | "task_plan" | "text_delta" | "usage_progress" | "usage" | "billing_usage" | "tool_call" | "permission_decision" | "tool_result" | "diff_created" | "learning_result" | "approval_required" | "completed" | "error";
  content?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId: string; name: string; ok: boolean; content: string; diff?: DiffResult; diffs?: DiffResult[]; auditEventId?: string; exitCode?: number; process?: ManagedProcessView };
  conversationId?: string;
  answer?: string;
  message?: string;
  approvals?: PendingApproval[];
  diffs?: DiffResult[];
  phase?: WorkflowPhase;
  label?: string;
  plan?: TaskPlanView;
  snapshot?: ProjectSession["contextSnapshot"];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    estimated?: boolean;
  };
  model?: string;
  provider?: string;
  status?: LearningRunStatus;
  recordsSaved?: number;
  reason?: string;
  createdAt?: string;
}

/** 文件 diff 信息 */
interface DiffResult {
  filePath: string;
  oldContent: string | null;
  newContent: string;
  lines: Array<{ type: "same" | "add" | "remove"; content: string; oldLine?: number; newLine?: number }>;
  addedLines: number;
  removedLines: number;
}

type DiffLine = DiffResult["lines"][number];
type DiffReviewRow =
  | { kind: "line"; line: DiffLine; index: number }
  | { kind: "fold"; hiddenCount: number; key: string };
type SplitDiffReviewRow =
  | { kind: "pair"; key: string; oldLine?: DiffLine; newLine?: DiffLine }
  | { kind: "fold"; hiddenCount: number; key: string };
type DiffViewMode = "split" | "unified";

interface EditPreviewLine {
  type: "same" | "add" | "remove" | "meta";
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface EditPreview {
  label: string;
  lines: EditPreviewLine[];
  totalLines: number;
}

const workspaceStorageKey = "agent.workspace.projects.v1";
const sidebarCollapsedStorageKey = "agent.workspace.sidebarCollapsed.v1";
const sidebarWidthStorageKey = "agent.workspace.sidebarWidth.v1";
const projectSessionCollapsedStorageKey = "agent.workspace.projectSessionCollapsed.v1";
const aiDisabledProviderMonitoringStorageKey = "agent.ai.disabledProviderMonitoring.v1";
const aiRealtimeMonitorIntervalMs = 15_000;

function loadDisabledAiProviderMonitoringIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(aiDisabledProviderMonitoringStorageKey) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && Boolean(id)) : []);
  } catch {
    return new Set<string>();
  }
}

const temporaryProjectId = "project_unassigned";
const temporaryProjectName = "不使用项目";
const defaultSidebarWidth = 318;
const minSidebarWidth = 220;
const maxSidebarWidth = 520;
const sessionArchiveSwipeThreshold = 82;
const sessionArchiveSwipeMax = 96;
const editPreviewContextLines = 2;
const editPreviewLineLimit = 90;
const API_BASE = import.meta.env.VITE_API_BASE || (window.location.protocol === "file:" || window.agentDesktop?.isDesktopClient ? "http://localhost:8787" : "");
const AI_PROVIDER_QUICK_CONNECTS: Record<string, AiProviderQuickConnect> = {
  deepseek: {
    label: "DeepSeek", mark: "D", accent: "#4d6bfe", displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-flash",
    modelsPath: "/models", balancePath: "https://api.deepseek.com/user/balance", chatCompletionsPath: "/chat/completions"
  },
  zhipu: {
    label: "智谱 GLM", mark: "G", accent: "#326bff", displayName: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY", defaultModel: "glm-5.2",
    modelsPath: "/models", chatCompletionsPath: "/chat/completions"
  },
  mimo: {
    label: "小米 MiMo", mark: "M", accent: "#ff6900", displayName: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "AI_API_KEY", defaultModel: "mimo-v2.5-pro",
    modelsPath: "/models", chatCompletionsPath: "/chat/completions"
  },
  minimax: {
    label: "MiniMax", mark: "MM", accent: "#ef476f", displayName: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1", apiKeyEnv: "MINIMAX_API_KEY", defaultModel: "MiniMax-M2.7",
    modelsPath: "/models", chatCompletionsPath: "/chat/completions"
  },
  kimi: {
    label: "Kimi", mark: "K", accent: "#3b82f6", displayName: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_API_KEY", defaultModel: "kimi-k2.6",
    modelsPath: "/models", chatCompletionsPath: "/chat/completions"
  }
};
const thinkingOptions: Array<{ id: ThinkingMode; label: string }> = [
  { id: "fast", label: "快速" },
  { id: "balanced", label: "标准" },
  { id: "deep", label: "深度" }
];

const defaultPermissionOptions: PermissionOption[] = [
  { id: "default", label: "默认", description: "使用配置文件中的默认工作区沙箱策略" },
  { id: "plan", label: "计划", description: "只读规划模式，不允许写文件、联网或执行命令" },
  { id: "workspace_write", label: "工作区", description: "项目内自主执行，越界、联网和危险操作请求审批" },
  { id: "custom", label: "自定义", description: "按自定义权限规则执行" },
  { id: "full_access", label: "完全访问", description: "允许所有工具操作直接执行，高风险" }
];

const toolActionLabels: Record<string, { running: string; completed: string; noun: string }> = {
  read_file: { running: "正在读取", completed: "已读取", noun: "个文件" },
  write_file: { running: "正在编辑", completed: "已编辑", noun: "个文件" },
  run_shell: { running: "正在运行", completed: "已运行", noun: "条命令" },
  start_process: { running: "正在启动", completed: "已启动", noun: "个进程" },
  read_process: { running: "正在读取", completed: "已读取", noun: "个进程" },
  write_process: { running: "正在发送", completed: "已发送", noun: "次输入" },
  stop_process: { running: "正在停止", completed: "已停止", noun: "个进程" },
  list_processes: { running: "正在检查", completed: "已检查", noun: "次进程列表" },
  web_fetch: { running: "正在获取", completed: "已获取", noun: "个网页" }
};

type ToolActivityCategory = "command" | "edit" | "read" | "lookup" | "other";

const toolActivityOrder: ToolActivityCategory[] = ["command", "edit", "read", "lookup", "other"];

const toolActivityLabels: Record<ToolActivityCategory, { title: string; running: string; completed: string; noun: string; target: string }> = {
  command: { title: "执行指令", running: "正在执行", completed: "已执行", noun: "条指令", target: "指令" },
  edit: { title: "编辑文件", running: "正在编辑", completed: "已编辑", noun: "个文件", target: "编辑" },
  read: { title: "读取文件", running: "正在读取", completed: "已读取", noun: "个文件", target: "读取" },
  lookup: { title: "查取文件", running: "正在查取", completed: "已查取", noun: "项", target: "查取" },
  other: { title: "调用工具", running: "正在调用", completed: "已调用", noun: "个工具", target: "工具" }
};

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

const legacyWelcomeMessage = "你好，我是本地 Agent。你可以像聊天一样输入任务，按 Enter 发送；需要换行时按 Shift + Enter。";

function createSession(title = "新会话"): ProjectSession {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    pendingApprovals: []
  };
}

function createProject(name: string, kind: ProjectKind, path?: string): AgentProject {
  const now = new Date().toISOString();
  return {
    id: createId("project"),
    name,
    kind,
    path,
    createdAt: now,
    updatedAt: now,
    sessions: [createSession()]
  };
}

function getTimestampValue(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getLatestTimestamp(...values: string[]) {
  return values.reduce((latest, value) => (getTimestampValue(value) > getTimestampValue(latest) ? value : latest), values[0] ?? new Date().toISOString());
}

function getEarliestTimestamp(...values: string[]) {
  return values.reduce((earliest, value) => (getTimestampValue(value) < getTimestampValue(earliest) ? value : earliest), values[0] ?? new Date().toISOString());
}

function createTemporaryProject(sessions: ProjectSession[] = []): AgentProject {
  const now = new Date().toISOString();
  const sortedSessions = [...sessions].sort((a, b) => getTimestampValue(b.updatedAt) - getTimestampValue(a.updatedAt));
  return {
    id: temporaryProjectId,
    name: temporaryProjectName,
    kind: "temporary",
    createdAt: sessions.length > 0 ? getEarliestTimestamp(...sessions.map((session) => session.createdAt)) : now,
    updatedAt: sessions.length > 0 ? getLatestTimestamp(...sessions.map((session) => session.updatedAt)) : now,
    sessions: sortedSessions
  };
}

function normalizeSessionRuntimeState(session: ProjectSession): ProjectSession {
  const activePhases: WorkflowPhase[] = ["preparing", "planning", "thinking", "inspecting", "executing"];
  const messages = session.messages
    // A request cannot survive an app reload. Drop its empty placeholder while
    // retaining partial replies, and migrate away the legacy welcome row.
    .filter((message) =>
      !(message.role === "assistant" && message.isStreaming && !message.content.trim()) &&
      !(message.role === "assistant" && message.content === legacyWelcomeMessage)
    )
    .map((message) => ({
      ...message,
      isStreaming: false,
      status: message.status === "running" ? "error" as const : message.status
    }));

  if (!session.workflowPhase || !activePhases.includes(session.workflowPhase)) {
    return { ...session, messages };
  }

  return {
    ...session,
    messages,
    workflowPhase: "stopped",
    workflowLabel: "上次任务已结束"
  };
}

function normalizeWorkspaceState(state: WorkspaceState): WorkspaceState {
  const temporaryProjects = state.projects.filter((project) => project.kind === "temporary");
  const regularProjects = state.projects.filter((project) => project.kind !== "temporary");
  const temporarySessions = temporaryProjects.flatMap((project) => project.sessions).map(normalizeSessionRuntimeState);
  const temporaryProject = createTemporaryProject(temporarySessions);
  let projects = [
    ...regularProjects.map((project) => ({
      ...project,
      sessions: project.sessions.map(normalizeSessionRuntimeState)
    })),
    temporaryProject
  ];
  const activeWasTemporary = temporaryProjects.some((project) => project.id === state.activeProjectId);
  let activeProjectId = activeWasTemporary ? temporaryProjectId : state.activeProjectId;
  let activeSessionId = state.activeSessionId;
  let activeProject = projects.find((project) => project.id === activeProjectId);

  if (!activeProject) {
    activeProject = regularProjects[0] ?? temporaryProject;
    activeProjectId = activeProject.id;
  }

  if (activeProject.sessions.length === 0) {
    const fallbackSession = createSession(activeProject.kind === "temporary" ? "临时会话" : "新会话");
    projects = projects.map((project) =>
      project.id === activeProjectId
        ? { ...project, updatedAt: fallbackSession.updatedAt, sessions: [fallbackSession] }
        : project
    );
    activeProject = projects.find((project) => project.id === activeProjectId)!;
    activeSessionId = fallbackSession.id;
  }

  if (!activeProject.sessions.some((session) => session.id === activeSessionId && !session.archivedAt)) {
    activeSessionId = activeProject.sessions.find((session) => !session.archivedAt)?.id ?? activeProject.sessions[0].id;
  }

  return { projects, activeProjectId, activeSessionId };
}

function getDefaultWorkspace(): WorkspaceState {
  const project = createProject("Rcode", "empty");
  return normalizeWorkspaceState({
    projects: [project],
    activeProjectId: project.id,
    activeSessionId: project.sessions[0].id
  });
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as WorkspaceState;
  return Array.isArray(state.projects) && typeof state.activeProjectId === "string" && typeof state.activeSessionId === "string";
}

function getPersistableWorkspaceState(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) => ({
          ...message,
          attachments: message.attachments?.map(({ dataUrl: _dataUrl, text: _text, ...attachment }) => attachment)
        }))
      }))
    }))
  };
}

function loadWorkspaceState(): WorkspaceState {
  try {
    const parsed = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null");
    if (isWorkspaceState(parsed) && parsed.projects.length > 0) return normalizeWorkspaceState(parsed);
  } catch { /* ignore */ }
  return getDefaultWorkspace();
}

function clampSidebarWidth(width: number) {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)));
}

function loadSidebarWidth() {
  const saved = Number(localStorage.getItem(sidebarWidthStorageKey));
  return Number.isFinite(saved) ? clampSidebarWidth(saved) : defaultSidebarWidth;
}

function loadProjectSessionCollapsedState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(projectSessionCollapsedStorageKey) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => typeof key === "string" && typeof value === "boolean")
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function formatTaskDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatResponseDuration(durationMs: number) {
  const safeDuration = Math.max(0, durationMs);
  if (safeDuration < 1000) return `${Math.max(0.1, safeDuration / 1000).toFixed(1)} 秒`;
  if (safeDuration < 60_000) return `${(safeDuration / 1000).toFixed(safeDuration < 10_000 ? 1 : 0)} 秒`;
  return formatTaskDuration(safeDuration);
}

function formatUsageNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}

function formatBalanceAmount(currency: string, amount: number) {
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function getDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getUsageWeekKey(date: Date) {
  const start = addDays(date, -date.getDay());
  return getDateKey(start);
}

function getUsageLevel(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.18) return 2;
  return 1;
}

function buildUsageActivityGrid(
  daily: NonNullable<UsageSummary["daily"]>,
  mode: UsageActivityMode,
  today = new Date()
) {
  const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const totalDays = 53 * 7;
  const start = addDays(normalizedToday, -(totalDays - 1));
  const dailyMap = new Map(daily.map((item) => [item.date, item]));
  const weeklyTotals = new Map<string, number>();
  daily.forEach((item) => {
    const date = new Date(`${item.date}T00:00:00`);
    const weekKey = getUsageWeekKey(date);
    weeklyTotals.set(weekKey, (weeklyTotals.get(weekKey) ?? 0) + item.totalTokens);
  });

  let runningTotal = 0;
  const rawValues: number[] = [];
  const dates = Array.from({ length: totalDays }, (_, index) => addDays(start, index));
  dates.forEach((date) => {
    const dateKey = getDateKey(date);
    const dayTokens = dailyMap.get(dateKey)?.totalTokens ?? 0;
    if (mode === "total") runningTotal += dayTokens;
    rawValues.push(
      mode === "weekly"
        ? (weeklyTotals.get(getUsageWeekKey(date)) ?? 0)
        : mode === "total"
          ? runningTotal
          : dayTokens
    );
  });

  const positiveValues = rawValues.filter((value) => value > 0);
  const maxValue = positiveValues.length > 0 ? Math.max(...positiveValues) : 0;
  const cells = dates.map((date, index) => {
    const dateKey = getDateKey(date);
    const item = dailyMap.get(dateKey);
    const value = rawValues[index];
    return {
      dateKey,
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekday: date.getDay(),
      value,
      calls: item?.calls ?? 0,
      level: getUsageLevel(value, maxValue)
    };
  });

  const monthLabels: Array<{ key: string; label: string; column: number }> = [];
  let previousMonth = -1;
  dates.forEach((date, index) => {
    const month = date.getMonth();
    if (month !== previousMonth && date.getDate() <= 7) {
      monthLabels.push({
        key: `${date.getFullYear()}-${month}`,
        label: `${month + 1}月`,
        column: Math.floor(index / 7) + 1
      });
      previousMonth = month;
    }
  });

  return { cells, monthLabels };
}

function summarizeArguments(args: Record<string, unknown>) {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 90)}`)
    .join("\n");
}

function normalizeCodeBlockContent(code: string) {
  return code.replace(/^\n/, "").replace(/\n$/, "");
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function MessageCodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const codeContent = normalizeCodeBlockContent(code);
  const label = language?.trim() || "text";

  useEffect(() => {
    if (!copied) return undefined;
    const timeoutId = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  return (
    <figure className="messageCodeBlock">
      <figcaption className="messageCodeHeader">
        <span>{label}</span>
        <button
          aria-label={copied ? "已复制代码" : "复制代码"}
          className="messageCodeCopy"
          onClick={async () => {
            await copyTextToClipboard(codeContent);
            setCopied(true);
          }}
          title={copied ? "已复制" : "复制"}
          type="button"
        >
          {copied ? <Check size={18} strokeWidth={2.15} /> : <Copy size={18} strokeWidth={2.05} />}
        </button>
      </figcaption>
      <pre className="messageCodePre">
        <code>{codeContent}</code>
      </pre>
    </figure>
  );
}

type MessageLinkTarget = { kind: "url" | "file"; value: string };

const commonFileExtensionPattern = "(?:tsx?|jsx?|mjs|cjs|jsonc?|mdx?|css|scss|html?|vue|svelte|py|r|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|zsh|fish|toml|ya?ml|xml|sql|txt|pdf|docx?|xlsx?|pptx?|csv|tsv|png|jpe?g|gif|webp|svg|zip|gz|lock|env)";
const inlineMessagePattern = new RegExp(
  [
    "\\[([^\\]\\n]+)\\]\\((<[^>\\n]+>|[^)\\n]+)\\)",
    "`([^`\\n]+)`",
    "(https?:\\/\\/[^\\s<>()]+|file:\\/\\/\\/[^\\s<>()]+|(?:~\\/|\\.\\.?\\/|\\/)[^\\s<>()]+|(?:[A-Za-z]:[\\\\/])[^\\s<>()]+|(?:[\\w@.+-]+[\\\\/])+[\\w@.+ -]+|[\\w@+-]+\\." + commonFileExtensionPattern + "(?::\\d+(?::\\d+)?)?)"
  ].join("|"),
  "gi"
);

function classifyMessageLink(rawTarget: string): MessageLinkTarget | undefined {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (/^https?:\/\//i.test(target)) return { kind: "url", value: target };
  if (/^file:\/\//i.test(target)) return { kind: "file", value: target };
  if (/^(?:~\/|\.\.?\/|\/|[A-Za-z]:[\\/])/.test(target)) return { kind: "file", value: target };
  if (/[\\/]/.test(target) || new RegExp(`\\.${commonFileExtensionPattern}(?::\\d+(?::\\d+)?)?$`, "i").test(target)) {
    return { kind: "file", value: target };
  }
  return undefined;
}

function trimAutoLinkTarget(rawTarget: string) {
  const match = rawTarget.match(/^(.*?)([.,!?;:，。！？；：、]+)?$/);
  return { target: match?.[1] ?? rawTarget, trailing: match?.[2] ?? "" };
}

function normalizeOpenFilePath(target: string) {
  if (/^file:\/\//i.test(target)) return target;
  return target.replace(/#L\d+(?:C\d+)?$/i, "").replace(/:(\d+)(?::\d+)?$/, "");
}

function handleMessageLinkClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  target: MessageLinkTarget,
  projectPath?: string
) {
  if (target.kind === "url") {
    if (!window.agentDesktop?.openExternalUrl) return;
    event.preventDefault();
    void window.agentDesktop.openExternalUrl(target.value);
    return;
  }

  event.preventDefault();
  void window.agentDesktop?.openLocalPath?.({
    path: normalizeOpenFilePath(target.value),
    basePath: projectPath
  });
}

function MessageLink({ children, target, projectPath }: { children: ReactNode; target: MessageLinkTarget; projectPath?: string }) {
  const isFile = target.kind === "file";
  return (
    <a
      className={`messageLink ${isFile ? "file" : "url"}`}
      href={isFile ? "#" : target.value}
      onClick={(event) => handleMessageLinkClick(event, target, projectPath)}
      rel={isFile ? undefined : "noreferrer"}
      target={isFile ? undefined : "_blank"}
      title={isFile ? `打开文件：${target.value}` : `在浏览器中打开：${target.value}`}
    >
      {children}
    </a>
  );
}

function renderInlineMessageContent(content: string, keyPrefix: string, projectPath?: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  inlineMessagePattern.lastIndex = 0;

  while ((match = inlineMessagePattern.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index));

    const markdownLabel = match[1];
    const markdownTarget = match[2];
    const inlineCode = match[3];
    const autoTarget = match[4];
    const key = `${keyPrefix}-inline-${match.index}`;

    if (markdownLabel !== undefined && markdownTarget !== undefined) {
      const target = classifyMessageLink(markdownTarget);
      parts.push(target
        ? <MessageLink key={key} target={target} projectPath={projectPath}>{markdownLabel}</MessageLink>
        : match[0]);
    } else if (inlineCode !== undefined) {
      const target = classifyMessageLink(inlineCode);
      parts.push(
        <code className={`inlineCode ${target ? "linked" : ""}`} key={key}>
          {target ? <MessageLink target={target} projectPath={projectPath}>{inlineCode}</MessageLink> : inlineCode}
        </code>
      );
    } else if (autoTarget !== undefined) {
      const { target: cleanTarget, trailing } = trimAutoLinkTarget(autoTarget);
      const target = classifyMessageLink(cleanTarget);
      parts.push(target
        ? <Fragment key={key}><MessageLink target={target} projectPath={projectPath}>{cleanTarget}</MessageLink>{trailing}</Fragment>
        : match[0]);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) parts.push(content.slice(lastIndex));
  return parts;
}

function renderMessageContent(content: string, projectPath?: string) {
  const parts: ReactNode[] = [];
  const codeFencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeFencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderInlineMessageContent(content.slice(lastIndex, match.index), `text-${lastIndex}`, projectPath));
    }
    parts.push(
      <MessageCodeBlock
        code={match[2] ?? ""}
        key={`code-${match.index}`}
        language={match[1]?.trim()}
      />
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(...renderInlineMessageContent(content.slice(lastIndex), `text-${lastIndex}`, projectPath));
  }

  return parts;
}

function getToolShortTarget(message: ChatMessage) {
  const pathArg = message.toolArgs?.path as string | undefined;
  const commandArg = message.toolArgs?.command as string | undefined;
  const urlArg = message.toolArgs?.url as string | undefined;
  const target = pathArg ?? commandArg ?? urlArg ?? "";
  if (!target) return "";
  return target.length > 34 ? `...${target.slice(-31)}` : target;
}

function getFileName(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function normalizeFilePath(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

function getDisplayFilePath(filePath: string, projectPath?: string) {
  const normalizedPath = normalizeFilePath(filePath);
  const normalizedProject = projectPath ? normalizeFilePath(projectPath).replace(/\/$/, "") : "";
  if (normalizedProject && normalizedPath.startsWith(`${normalizedProject}/`)) {
    return normalizedPath.slice(normalizedProject.length + 1);
  }
  return normalizedPath;
}

function getDiffEditKind(diff?: DiffResult) {
  if (!diff) return "编辑中";
  if (diff.oldContent === null) return "新增";
  if (diff.addedLines > 0 && diff.removedLines > 0) return "修改";
  if (diff.addedLines > 0) return "新增内容";
  if (diff.removedLines > 0) return "删减";
  return "更新";
}

function getEditSummaryText(diffs: DiffResult[]) {
  if (diffs.length === 0) return "等待文件变更结果";
  const created = diffs.filter((diff) => diff.oldContent === null).length;
  const changed = diffs.length - created;
  const parts = [
    created > 0 ? `新增 ${created} 个文件` : "",
    changed > 0 ? `修改 ${changed} 个文件` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("，") : "已更新文件内容";
}

function lineCount(text: string) {
  if (!text) return 0;
  return text.split("\n").length;
}

interface LineChangeStats {
  addedLines: number;
  removedLines: number;
  isEstimate: boolean;
}

/**
 * Show line totals as soon as an edit tool starts. The server-provided diff is
 * still authoritative and replaces this lightweight argument preview when the
 * tool finishes.
 */
function getToolLineChangeStats(message: ChatMessage): LineChangeStats {
  if (message.diff) {
    return {
      addedLines: message.diff.addedLines,
      removedLines: message.diff.removedLines,
      isEstimate: false
    };
  }

  if (message.status !== "running" || !message.toolArgs || !isEditToolName(message.toolName)) {
    return { addedLines: 0, removedLines: 0, isEstimate: false };
  }

  const patchArg = typeof message.toolArgs.patch === "string" ? message.toolArgs.patch : "";
  if (patchArg) {
    const patchLines = patchArg.split("\n");
    let insideHunk = false;
    let addedLines = 0;
    let removedLines = 0;
    patchLines.forEach((line) => {
      if (line.startsWith("@@")) {
        insideHunk = true;
        return;
      }
      if (!insideHunk) return;
      if (line.startsWith("+")) addedLines += 1;
      if (line.startsWith("-")) removedLines += 1;
    });
    return {
      addedLines,
      removedLines,
      isEstimate: true
    };
  }

  const oldTextArg = typeof message.toolArgs.oldText === "string" ? message.toolArgs.oldText : "";
  const newTextArg = typeof message.toolArgs.newText === "string" ? message.toolArgs.newText : "";
  if (oldTextArg || newTextArg) {
    return {
      addedLines: lineCount(newTextArg),
      removedLines: lineCount(oldTextArg),
      isEstimate: true
    };
  }

  const contentArg = typeof message.toolArgs.content === "string" ? message.toolArgs.content : "";
  if (message.toolName === "write_file" && contentArg) {
    return {
      addedLines: lineCount(contentArg),
      removedLines: 0,
      isEstimate: true
    };
  }

  return { addedLines: 0, removedLines: 0, isEstimate: false };
}

function trimEditPreviewLines(lines: EditPreviewLine[], limit = editPreviewLineLimit) {
  if (lines.length <= limit) return lines;
  const hiddenCount = lines.length - limit;
  return [
    ...lines.slice(0, limit),
    { type: "meta" as const, content: `... 已隐藏 ${hiddenCount} 行` }
  ];
}

function getCompactDiffPreviewLines(diff: DiffResult) {
  const includedIndexes = new Set<number>();
  diff.lines.forEach((line, index) => {
    if (line.type === "same") return;
    const start = Math.max(0, index - editPreviewContextLines);
    const end = Math.min(diff.lines.length - 1, index + editPreviewContextLines);
    for (let cursor = start; cursor <= end; cursor++) {
      includedIndexes.add(cursor);
    }
  });

  if (includedIndexes.size === 0) {
    return trimEditPreviewLines(diff.lines.slice(0, 18));
  }

  const previewLines: EditPreviewLine[] = [];
  let previousIndex = -1;
  [...includedIndexes].sort((a, b) => a - b).forEach((index) => {
    if (previousIndex !== -1 && index > previousIndex + 1) {
      previewLines.push({ type: "meta", content: `... 跳过 ${index - previousIndex - 1} 行未变更内容` });
    }
    previewLines.push(diff.lines[index]);
    previousIndex = index;
  });
  return trimEditPreviewLines(previewLines);
}

function getDiffReviewRows(diff: DiffResult, contextLines = 3): DiffReviewRow[] {
  const rows: DiffReviewRow[] = [];
  let index = 0;
  while (index < diff.lines.length) {
    const line = diff.lines[index];
    if (line.type !== "same") {
      rows.push({ kind: "line", line, index });
      index += 1;
      continue;
    }

    const start = index;
    while (index < diff.lines.length && diff.lines[index].type === "same") {
      index += 1;
    }
    const end = index;
    const count = end - start;

    if (count > contextLines * 2 + 4) {
      for (let cursor = start; cursor < start + contextLines; cursor++) {
        rows.push({ kind: "line", line: diff.lines[cursor], index: cursor });
      }
      rows.push({
        kind: "fold",
        hiddenCount: count - contextLines * 2,
        key: `${start}-${end}`
      });
      for (let cursor = end - contextLines; cursor < end; cursor++) {
        rows.push({ kind: "line", line: diff.lines[cursor], index: cursor });
      }
    } else {
      for (let cursor = start; cursor < end; cursor++) {
        rows.push({ kind: "line", line: diff.lines[cursor], index: cursor });
      }
    }
  }
  return rows;
}

function getSplitDiffReviewRows(rows: DiffReviewRow[]): SplitDiffReviewRow[] {
  const splitRows: SplitDiffReviewRow[] = [];
  let cursor = 0;

  while (cursor < rows.length) {
    const row = rows[cursor];
    if (row.kind === "fold") {
      splitRows.push(row);
      cursor += 1;
      continue;
    }

    if (row.line.type === "same") {
      splitRows.push({ kind: "pair", key: `same-${row.index}`, oldLine: row.line, newLine: row.line });
      cursor += 1;
      continue;
    }

    const changedRows: Array<Extract<DiffReviewRow, { kind: "line" }>> = [];
    while (cursor < rows.length) {
      const candidate = rows[cursor];
      if (candidate.kind !== "line" || candidate.line.type === "same") break;
      changedRows.push(candidate);
      cursor += 1;
    }

    const removedLines = changedRows.filter((changed) => changed.line.type === "remove").map((changed) => changed.line);
    const addedLines = changedRows.filter((changed) => changed.line.type === "add").map((changed) => changed.line);
    const pairCount = Math.max(removedLines.length, addedLines.length);

    for (let index = 0; index < pairCount; index += 1) {
      splitRows.push({
        kind: "pair",
        key: `change-${changedRows[0].index}-${index}`,
        oldLine: removedLines[index],
        newLine: addedLines[index]
      });
    }
  }

  return splitRows;
}

function getPatchPreviewLines(patchText: string) {
  const lines = patchText.split("\n").map<EditPreviewLine>((line) => {
    if (line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("index ")) {
      return { type: "meta", content: line };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return { type: "add", content: line.slice(1) };
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return { type: "remove", content: line.slice(1) };
    }
    if (line.startsWith(" ")) {
      return { type: "same", content: line.slice(1) };
    }
    return { type: "meta", content: line };
  });
  return trimEditPreviewLines(lines);
}

function getTextBlockPreviewLines(text: string, type: EditPreviewLine["type"]) {
  return trimEditPreviewLines(text.split("\n").map((content, index) => (
    type === "add"
      ? { type, content, newLine: index + 1 }
      : type === "remove"
        ? { type, content, oldLine: index + 1 }
        : { type, content, oldLine: index + 1, newLine: index + 1 }
  )));
}

function getEditPreview(message: ChatMessage): EditPreview | undefined {
  if (message.diff) {
    return {
      label: "实时 diff",
      lines: getCompactDiffPreviewLines(message.diff),
      totalLines: message.diff.lines.length
    };
  }

  if (!message.toolArgs || !isEditToolName(message.toolName)) return undefined;

  const contentArg = typeof message.toolArgs.content === "string" ? message.toolArgs.content : "";
  if (message.toolName === "write_file" && contentArg) {
    return {
      label: `即将写入完整内容 · ${lineCount(contentArg)} 行`,
      lines: getTextBlockPreviewLines(contentArg, "add"),
      totalLines: lineCount(contentArg)
    };
  }

  const patchArg = typeof message.toolArgs.patch === "string" ? message.toolArgs.patch : "";
  if (patchArg) {
    return {
      label: `补丁预览 · ${lineCount(patchArg)} 行`,
      lines: getPatchPreviewLines(patchArg),
      totalLines: lineCount(patchArg)
    };
  }

  const oldTextArg = typeof message.toolArgs.oldText === "string" ? message.toolArgs.oldText : "";
  const newTextArg = typeof message.toolArgs.newText === "string" ? message.toolArgs.newText : "";
  if (oldTextArg || newTextArg) {
    const lines = [
      ...(oldTextArg ? getTextBlockPreviewLines(oldTextArg, "remove") : []),
      ...(newTextArg ? getTextBlockPreviewLines(newTextArg, "add") : [])
    ];
    return {
      label: "替换文本预览",
      lines: trimEditPreviewLines(lines),
      totalLines: lineCount(oldTextArg) + lineCount(newTextArg)
    };
  }

  return undefined;
}

function isEditToolName(toolName?: string) {
  return toolName === "write_file" || toolName === "apply_patch";
}

function getToolDisplayTarget(message: ChatMessage) {
  const pathArg = message.toolArgs?.path as string | undefined;
  const commandArg = message.toolArgs?.command as string | undefined;
  const urlArg = message.toolArgs?.url as string | undefined;
  const processIdArg = message.toolArgs?.processId as string | undefined;
  if (pathArg) return getFileName(pathArg);
  const target = commandArg ?? processIdArg ?? urlArg ?? "";
  if (!target) return "";
  return target.length > 42 ? `...${target.slice(-39)}` : target;
}

function getToolActivityCategory(toolName?: string): ToolActivityCategory {
  if (toolName === "run_shell" || toolName === "start_process" || toolName === "read_process" || toolName === "write_process" || toolName === "stop_process" || toolName === "list_processes") return "command";
  if (toolName === "write_file" || toolName === "apply_patch") return "edit";
  if (toolName === "read_file") return "read";
  if (toolName === "list_files" || toolName === "search_text" || toolName === "inspect_tree" || toolName === "web_fetch") return "lookup";
  return "other";
}

function getRealtimeToolStatus(toolName?: string): { phase: WorkflowPhase; label: string } {
  if (toolName === "read_file") return { phase: "inspecting", label: "正在读取文件" };
  if (toolName === "list_files" || toolName === "inspect_tree") return { phase: "inspecting", label: "正在查看项目文件" };
  if (toolName === "search_text") return { phase: "inspecting", label: "正在搜索代码" };
  if (toolName === "write_file" || toolName === "apply_patch") return { phase: "executing", label: "正在编辑文件" };
  if (toolName === "web_fetch") return { phase: "inspecting", label: "正在获取网页" };
  if (toolName === "run_shell") return { phase: "executing", label: "正在执行操作" };
  if (toolName === "start_process") return { phase: "executing", label: "正在启动进程" };
  if (toolName === "read_process" || toolName === "list_processes") return { phase: "inspecting", label: "正在检查进程" };
  if (toolName === "write_process") return { phase: "executing", label: "正在操作进程" };
  if (toolName === "stop_process") return { phase: "executing", label: "正在停止进程" };
  if (toolName === "git_status" || toolName === "git_diff") return { phase: "inspecting", label: "正在检查代码变更" };
  if (toolName === "git_branch" || toolName === "git_stage" || toolName === "git_commit") return { phase: "executing", label: "正在执行 Git 操作" };
  if (toolName?.startsWith("mcp__")) return { phase: "executing", label: "正在调用外部工具" };
  return { phase: "executing", label: "正在调用工具" };
}

function getWorkflowActivityLabel(phase?: WorkflowPhase) {
  if (phase === "preparing") return "准备中";
  if (phase === "planning") return "规划中";
  if (phase === "inspecting") return "检查中";
  if (phase === "executing") return "执行中";
  if (phase === "awaiting_approval") return "等待中";
  return "思考中";
}

function getToolActivityTarget(message: ChatMessage, projectPath?: string) {
  const category = getToolActivityCategory(message.toolName);
  const pathArg = message.toolArgs?.path as string | undefined;
  const commandArg = message.toolArgs?.command as string | undefined;
  const urlArg = message.toolArgs?.url as string | undefined;
  const queryArg = message.toolArgs?.query as string | undefined;
  const processIdArg = message.toolArgs?.processId as string | undefined;

  if (category === "command" && commandArg) {
    return commandArg.length > 72 ? `${commandArg.slice(0, 69)}...` : commandArg;
  }

  if (category === "command" && processIdArg) return processIdArg;

  if ((category === "edit" || category === "read" || category === "lookup") && pathArg) {
    const displayPath = getDisplayFilePath(pathArg, projectPath);
    if (category === "lookup" && queryArg) {
      const query = queryArg.length > 28 ? `${queryArg.slice(0, 25)}...` : queryArg;
      return `${displayPath} · ${query}`;
    }
    return displayPath;
  }

  if (category === "lookup" && urlArg) {
    return urlArg.length > 72 ? `...${urlArg.slice(-69)}` : urlArg;
  }

  const fallback = pathArg ?? commandArg ?? processIdArg ?? urlArg ?? message.toolName ?? "";
  return fallback.length > 72 ? `...${fallback.slice(-69)}` : fallback;
}

function getToolActivityGroups(toolMessages: ChatMessage[], projectPath?: string) {
  return toolActivityOrder
    .map((category) => ({
      category,
      messages: toolMessages.filter((message) => getToolActivityCategory(message.toolName) === category),
      labels: toolActivityLabels[category]
    }))
    .filter((group) => group.messages.length > 0)
    .map((group) => ({
      ...group,
      targets: group.messages.map((message) => getToolActivityTarget(message, projectPath)).filter(Boolean)
    }));
}

type MessageRenderItem =
  | { type: "single"; message: ChatMessage }
  | { type: "toolGroup"; messages: ChatMessage[] };

function getMessageRenderItems(messages: ChatMessage[]): MessageRenderItem[] {
  const items: MessageRenderItem[] = [];
  let currentToolGroup: ChatMessage[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length === 0) return;
    items.push({ type: "toolGroup", messages: currentToolGroup });
    currentToolGroup = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      const currentCategory = currentToolGroup[0]
        ? getToolActivityCategory(currentToolGroup[0].toolName)
        : undefined;
      const nextCategory = getToolActivityCategory(message.toolName);

      // Only truly adjacent actions of the same kind share one disclosure row.
      // Empty assistant placeholders created between tool calls are intentionally
      // transparent so they neither split the group nor render repeated thinking UI.
      if (currentCategory && currentCategory !== nextCategory) flushToolGroup();
      currentToolGroup.push(message);
      continue;
    }

    // Keep the active assistant placeholder in the render list so the
    // per-response progress row appears immediately, before the first token.
    if (
      message.role === "assistant" &&
      !message.content.trim() &&
      !message.isStreaming &&
      message.showResponseMeta !== true
    ) continue;

    if (currentToolGroup.length > 0) {
      const containsEdits = currentToolGroup.some((toolMessage) => isEditToolName(toolMessage.toolName));
      // Keep the final written delivery ahead of its edit artifact summary.
      if (message.role === "assistant" && containsEdits && message.status === "completed" && !message.isStreaming) {
        items.push({ type: "single", message });
        flushToolGroup();
        continue;
      }
      flushToolGroup();
    }

    items.push({ type: "single", message });
  }

  flushToolGroup();
  return items;
}

function formatToolActivityTargets(targets: string[]) {
  const uniqueTargets = [...new Set(targets)];
  const visibleTargets = uniqueTargets.slice(0, 2);
  const hiddenCount = uniqueTargets.length - visibleTargets.length;
  return `${visibleTargets.join("、")}${hiddenCount > 0 ? ` 等 ${hiddenCount + visibleTargets.length} 项` : ""}`;
}

function getToolGroupSummary(toolMessages: ChatMessage[], projectPath?: string) {
  const isMessageRunning = (message: ChatMessage) => message.status === "running" || message.toolResult?.process?.status === "running";
  const runningCount = toolMessages.filter(isMessageRunning).length;
  const doneCount = toolMessages.filter((m) => m.status === "completed").length;
  const hasRunning = runningCount > 0;
  const allDone = doneCount === toolMessages.length;
  const toolNames = [...new Set(toolMessages.map((m) => m.toolName).filter(Boolean))] as string[];
  const primaryTool = toolNames.length === 1 ? toolNames[0] : undefined;
  const labels = primaryTool ? toolActionLabels[primaryTool] : undefined;
  const activityGroups = getToolActivityGroups(toolMessages, projectPath);
  const diffMessages = toolMessages.filter((message) => message.diff);
  const lineChanges = toolMessages.map(getToolLineChangeStats);
  const addedLines = lineChanges.reduce((sum, change) => sum + change.addedLines, 0);
  const removedLines = lineChanges.reduce((sum, change) => sum + change.removedLines, 0);
  const isDiffEstimate = lineChanges.some((change) => change.isEstimate);
  const focusedMessage =
    toolMessages.find(isMessageRunning) ??
    diffMessages[0] ??
    toolMessages.find((m) => m.toolArgs?.path || m.toolArgs?.command || m.toolArgs?.url) ??
    toolMessages[0];
  const target = focusedMessage ? getToolDisplayTarget(focusedMessage) : "";

  if (hasRunning) {
    const runningGroups = activityGroups.filter((group) => group.messages.some(isMessageRunning));
    const summaryGroups = runningGroups.length > 0 ? runningGroups : activityGroups;
    const label = summaryGroups
      .map((group) => {
        const count = group.messages.filter(isMessageRunning).length || group.messages.length;
        return `${group.labels.running} ${count} ${group.labels.noun}`;
      })
      .join("，");
    const detail = summaryGroups
      .map((group) => group.targets.length > 0 ? `${group.labels.target}：${formatToolActivityTargets(group.targets)}` : "")
      .filter(Boolean)
      .join(" · ");

    return {
      label: label || (labels ? `${labels.running} ${runningCount} ${labels.noun}` : `正在调用工具 ${toolNames.join(", ")}...`),
      detail: detail || (target ? `${labels?.running ?? "正在处理"} ${target}` : undefined),
      addedLines,
      removedLines,
      isDiffEstimate,
      isRunning: true,
      primaryTool
    };
  }

  if (allDone) {
    const label = activityGroups
      .map((group) => `${group.labels.completed} ${group.messages.length} ${group.labels.noun}`)
      .join("，");
    const detail = activityGroups
      .map((group) => group.targets.length > 0 ? `${group.labels.target}：${formatToolActivityTargets(group.targets)}` : "")
      .filter(Boolean)
      .join(" · ");

    return {
      label: label || (labels ? `${labels.completed} ${toolMessages.length} ${labels.noun}` : `已完成 ${toolMessages.length} 次工具调用`),
      detail: detail || (target ? `${labels?.completed ?? "已处理"} ${target}` : undefined),
      addedLines,
      removedLines,
      isDiffEstimate,
      isRunning: false,
      primaryTool
    };
  }

  return {
    label: `工具调用 ${toolNames.join(", ")} (${doneCount}/${toolMessages.length})`,
    detail: target ? `正在处理 ${target}` : undefined,
    addedLines,
    removedLines,
    isDiffEstimate,
    isRunning: false,
    primaryTool
  };
}

function getCompletedViewMessageIds(messages: ChatMessage[]) {
  const visibleIds = new Set<string>();
  const hasUserMessages = messages.some((message) => message.role === "user");

  if (!hasUserMessages) {
    messages.forEach((message) => {
      if (message.role !== "tool") visibleIds.add(message.id);
    });
    return visibleIds;
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user") continue;

    visibleIds.add(message.id);
    const nextUserIndex = messages.findIndex((item, nextIndex) => nextIndex > index && item.role === "user");
    const turnEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
    let finalAssistant: ChatMessage | undefined;

    for (let turnIndex = index + 1; turnIndex < turnEnd; turnIndex++) {
      const candidate = messages[turnIndex];
      if (
        candidate.role === "assistant" &&
        candidate.content.trim() &&
        !candidate.isStreaming &&
        candidate.status !== "approval_required"
      ) {
        finalAssistant = candidate;
      }
    }

    if (finalAssistant) {
      visibleIds.add(finalAssistant.id);
    }
  }

  return visibleIds;
}

function getResponseReplayMessages(messages: ChatMessage[], responseId: string) {
  const responseIndex = messages.findIndex((message) => message.id === responseId);
  if (responseIndex < 0) return [];

  let turnStart = -1;
  for (let index = responseIndex; index >= 0; index--) {
    if (messages[index].role === "user") {
      turnStart = index;
      break;
    }
  }

  const nextTurnIndex = messages.findIndex((message, index) => index > responseIndex && message.role === "user");
  const turnEnd = nextTurnIndex < 0 ? messages.length : nextTurnIndex;
  return messages.slice(turnStart + 1, turnEnd).filter((message) => message.role === "tool");
}

function getFolderName(folderPath: string) {
  return folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? folderPath;
}

function getSessionTitle(prompt: string) {
  return prompt.length > 24 ? `${prompt.slice(0, 24)}...` : prompt;
}

function getRelativeTime(date: string) {
  const elapsed = Date.now() - new Date(date).getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (elapsed < minute) return "刚刚";
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))} 分`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 时`;
  if (elapsed < week) return `${Math.floor(elapsed / day)} 天`;
  return `${Math.floor(elapsed / week)} 周`;
}

/** 解析 SSE 流 */
async function* parseSseStream(response: Response): AsyncGenerator<StreamEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const eventEnd = buffer.indexOf("\n\n");
      if (eventEnd === -1) break;

      const eventStr = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);

      const dataLine = eventStr.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;

      try {
        yield JSON.parse(dataLine.slice(6)) as StreamEvent;
      } catch { /* ignore */ }
    }
  }
}

export default function App() {
  const { user: authUser, logout } = useAuth();
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(() => loadWorkspaceState());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(sidebarCollapsedStorageKey) === "true");
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const [projectSessionCollapsed, setProjectSessionCollapsed] = useState<Record<string, boolean>>(
    () => loadProjectSessionCollapsedState()
  );
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [selectedSettingsSection, setSelectedSettingsSection] = useState<SettingsSectionId>("general");
  const [mode, setMode] = useState<PermissionMode>("workspace_write");
  const [localApiToken, setLocalApiToken] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [composerAttachmentsBySession, setComposerAttachmentsBySession] = useState<Record<string, ComposerAttachment[]>>({});
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem("agent.themePreference");
    return saved === "dark" || saved === "light" || saved === "system" ? saved : "system";
  });
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const [taskTimers, setTaskTimers] = useState<Record<string, TaskTimerState>>({});
  const [timerTick, setTimerTick] = useState(() => Date.now());
  const [health, setHealth] = useState<{ providerConfigured: boolean; model: string; provider?: string }>();
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("balanced");
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [managedProcessPanelOpen, setManagedProcessPanelOpen] = useState(false);
  const [managedProcesses, setManagedProcesses] = useState<ManagedProcessView[]>([]);
  const [managedProcessLoadError, setManagedProcessLoadError] = useState("");
  const [permissionOptions, setPermissionOptions] = useState<PermissionOption[]>(defaultPermissionOptions);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | undefined>();
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogItem[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[]>([]);
  const [aiActiveProviderId, setAiActiveProviderId] = useState("");
  const [aiProviderBalance, setAiProviderBalance] = useState<AiProviderBalance | undefined>();
  const [aiProviderBalanceLoading, setAiProviderBalanceLoading] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [learningRecords, setLearningRecords] = useState<LearningRecordItem[]>([]);
  const [latestLearningRun, setLatestLearningRun] = useState<LearningRunItem | undefined>();
  const [subagents, setSubagents] = useState<SubagentDefinition[]>([]);
  const [aiDraft, setAiDraft] = useState({
    id: "",
    displayName: "",
    baseUrl: "",
    apiKey: "",
    defaultModel: "gpt-4o",
    modelsPath: "/models",
    balancePath: "",
    chatCompletionsPath: "/chat/completions",
    apiKeyEnv: "AI_API_KEY",
    protocol: "openai-compatible" as string
  });
  const [aiDraftModels, setAiDraftModels] = useState<string[]>([]);
  const [aiDraftModelStatus, setAiDraftModelStatus] = useState("");
  const [aiDraftError, setAiDraftError] = useState("");
  const [aiDraftFetchingModels, setAiDraftFetchingModels] = useState(false);
  const [aiDraftSaving, setAiDraftSaving] = useState(false);
  const [aiProviderStatus, setAiProviderStatus] = useState<Record<string, string>>({});
  const [aiProviderBusy, setAiProviderBusy] = useState<Record<string, "activate" | "delete" | "test">>({});
  const [aiProviderHealth, setAiProviderHealth] = useState<Record<string, AiProviderHealth>>({});
  const [disabledAiProviderMonitoringIds, setDisabledAiProviderMonitoringIds] = useState<Set<string>>(() => loadDisabledAiProviderMonitoringIds());
  const [showAddProviderModal, setShowAddProviderModal] = useState(false);
  const [editingAiProviderId, setEditingAiProviderId] = useState<string | undefined>();
  const [mcpDraft, setMcpDraft] = useState({ name: "", command: "", url: "" });
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  const [mcpOauthClientIds, setMcpOauthClientIds] = useState<Record<string, string>>({});
  const [githubOauthClientSecret, setGithubOauthClientSecret] = useState("");
  const [githubMcpAuthorized, setGithubMcpAuthorized] = useState(false);
  const [usageActivityMode, setUsageActivityMode] = useState<UsageActivityMode>("daily");
  const [learningSearch, setLearningSearch] = useState("");
  const [learningCategory, setLearningCategory] = useState<LearningCategory | "all">("all");
  const [skillSearch, setSkillSearch] = useState("");
  const [skillScope, setSkillScope] = useState<AgentSkill["scope"] | "all">("all");
  const [selectedSkill, setSelectedSkill] = useState<AgentSkill | undefined>();
  const [skillDetailContent, setSkillDetailContent] = useState("");
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const isDesktopClient = Boolean(window.agentDesktop?.isDesktopClient);
  const messageListRef = useRef<HTMLDivElement>(null);
  const usageActivityScrollRef = useRef<HTMLDivElement>(null);
  const workspaceStateRef = useRef(workspaceState);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const aiProviderHealthChecksRef = useRef<Set<string>>(new Set());
  const aiProviderBalanceRequestRef = useRef(0);
  const themeToggleRef = useRef<HTMLButtonElement>(null);
  const themeTransitionRef = useRef<{ overlay: HTMLDivElement; timeoutId: number } | null>(null);
  const queuedPromptsRef = useRef<Map<string, QueuedPrompt[]>>(new Map());
  const sessionWheelSwipeRef = useRef<Map<string, { offset: number; timeoutId?: number }>>(new Map());
  const [queueVersion, setQueueVersion] = useState(0);
  const [sessionSwipeOffsets, setSessionSwipeOffsets] = useState<Record<string, number>>({});
  // 追踪用户手动关闭的工具折叠组，避免重渲染时自动展开
  const manualClosedGroupsRef = useRef<Set<string>>(new Set());
  // diff 对比面板
  const [diffPanel, setDiffPanel] = useState<DiffResult | null>(null);
  const [diffSearch, setDiffSearch] = useState("");
  const [diffChangesOnly, setDiffChangesOnly] = useState(false);
  const [diffPathCopied, setDiffPathCopied] = useState(false);
  const [diffView, setDiffView] = useState<DiffViewMode>("split");
  const [reviewDiffScope, setReviewDiffScope] = useState<DiffResult[] | null>(null);
  // 最终交付卡默认保持 Codex 式的一行摘要；完整文件清单按需展开，
  // 所有变更始终可在审核面板右侧切换。
  const [expandedArtifactCards, setExpandedArtifactCards] = useState<Set<string>>(() => new Set());
  const [expandedResponseReplays, setExpandedResponseReplays] = useState<Set<string>>(() => new Set());

  function markSessionRunning(sessionId: string) {
    const now = Date.now();
    setRunningSessionIds((cur) => new Set(cur).add(sessionId));
    setTaskTimers((cur) => ({
      ...cur,
      [sessionId]: { startedAt: now, elapsedMs: 0 }
    }));
    setTimerTick(now);
  }
  function markSessionIdle(sessionId: string) {
    const now = Date.now();
    setRunningSessionIds((cur) => {
      const next = new Set(cur);
      next.delete(sessionId);
      return next;
    });
    setTaskTimers((cur) => {
      const current = cur[sessionId];
      if (!current?.startedAt) return cur;
      return {
        ...cur,
        [sessionId]: {
          elapsedMs: current.elapsedMs + Math.max(0, now - current.startedAt)
        }
      };
    });
    setTimerTick(now);
  }

  const resolvedTheme = themePreference === "system" ? systemTheme : themePreference;
  const modelName = selectedModel || health?.model || "Agent";

  const activeProject = useMemo(
    () => workspaceState.projects.find((project) => project.id === workspaceState.activeProjectId),
    [workspaceState]
  );
  const activeSession = useMemo(
    () => activeProject?.sessions.find((session) => session.id === workspaceState.activeSessionId),
    [activeProject, workspaceState.activeSessionId]
  );
  const activeProjectUsage = useMemo(
    () => activeProject?.sessions.reduce(
      (projectTotal, session) => session.messages.reduce(
        (sessionTotal, message) => sessionTotal + (message.usage?.billedTotalTokens ?? message.usage?.totalTokens ?? 0),
        projectTotal
      ),
      0
    ) ?? 0,
    [activeProject]
  );
  const composerAttachments = activeSession ? (composerAttachmentsBySession[activeSession.id] ?? []) : [];
  const currentProjectManagedProcesses = useMemo(
    () => activeProject?.path ? managedProcesses.filter((process) => process.projectPath === activeProject.path) : [],
    [activeProject?.path, managedProcesses]
  );
  const currentMode = activeSession?.permissionMode ?? mode;
  const selectedPermission =
    permissionOptions.find((item) => item.id === currentMode) ??
    defaultPermissionOptions.find((item) => item.id === currentMode) ??
    defaultPermissionOptions[0];

  const messages = activeSession?.messages ?? [];
  const pendingApprovals = activeSession?.pendingApprovals ?? [];
  const conversationId = activeSession?.conversationId;
  const isActiveSessionRunning = activeSession ? runningSessionIds.has(activeSession.id) : false;
  const activeResponseMetaId = useMemo(() => {
    if (!isActiveSessionRunning) return undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "assistant" && message.showResponseMeta === true) return message.id;
    }
    return undefined;
  }, [isActiveSessionRunning, messages]);
  const activeTaskTimer = activeSession ? taskTimers[activeSession.id] : undefined;
  const activeTaskElapsedMs = activeTaskTimer
    ? activeTaskTimer.startedAt
      ? activeTaskTimer.elapsedMs + Math.max(0, timerTick - activeTaskTimer.startedAt)
      : activeTaskTimer.elapsedMs
    : 0;
  const shouldShowTaskDuration = Boolean(activeTaskTimer && isActiveSessionRunning);
  const activeWorkflowActivityLabel = getWorkflowActivityLabel(activeSession?.workflowPhase);
  const hasVisibleProcess =
    isActiveSessionRunning ||
    pendingApprovals.length > 0;
  const completedViewMessageIds = useMemo(
    () => (hasVisibleProcess ? undefined : getCompletedViewMessageIds(messages)),
    [hasVisibleProcess, messages]
  );
  const visibleMessages = useMemo(
    () =>
      completedViewMessageIds
        ? messages.filter((message) => {
            if (message.role !== "tool") return completedViewMessageIds.has(message.id);
            // 会话完成后压缩普通工具日志，但保留带有成功 diff 的编辑操作。
            // 编辑产物卡片与“审核”入口均由这些消息驱动，不能一并过滤。
            return Boolean(message.diff && message.toolResult?.ok !== false);
          })
        : messages,
    [completedViewMessageIds, messages]
  );
  const reviewDiffs = useMemo(() => {
    const diffs = new Map<string, DiffResult>();
    if (reviewDiffScope) {
      reviewDiffScope.forEach((diff) => diffs.set(normalizeFilePath(diff.filePath), diff));
    } else {
      messages.forEach((message) => {
        if (message.diff && message.toolResult?.ok !== false) {
          diffs.set(normalizeFilePath(message.diff.filePath), message.diff);
        }
      });
    }
    if (diffPanel) {
      diffs.set(normalizeFilePath(diffPanel.filePath), diffPanel);
    }
    return [...diffs.values()].sort((a, b) => normalizeFilePath(a.filePath).localeCompare(normalizeFilePath(b.filePath)));
  }, [diffPanel, messages, reviewDiffScope]);
  const diffReviewRows = useMemo(() => (diffPanel ? getDiffReviewRows(diffPanel) : []), [diffPanel]);
  const filteredReviewDiffs = useMemo(() => {
    const query = diffSearch.trim().toLocaleLowerCase();
    if (!query) return reviewDiffs;
    return reviewDiffs.filter((diff) => diff.filePath.toLocaleLowerCase().includes(query));
  }, [diffSearch, reviewDiffs]);
  const reviewTotals = useMemo(
    () => reviewDiffs.reduce(
      (totals, diff) => ({ added: totals.added + diff.addedLines, removed: totals.removed + diff.removedLines }),
      { added: 0, removed: 0 }
    ),
    [reviewDiffs]
  );
  const visibleDiffReviewRows = useMemo(
    () => diffChangesOnly
      ? diffReviewRows.filter((row): row is Extract<DiffReviewRow, { kind: "line" }> => row.kind === "line" && row.line.type !== "same")
      : diffReviewRows,
    [diffChangesOnly, diffReviewRows]
  );
  const splitDiffReviewRows = useMemo(
    () => getSplitDiffReviewRows(visibleDiffReviewRows),
    [visibleDiffReviewRows]
  );
  const activeReviewIndex = diffPanel
    ? reviewDiffs.findIndex((diff) => normalizeFilePath(diff.filePath) === normalizeFilePath(diffPanel.filePath))
    : -1;

  const selectAdjacentReviewFile = (direction: -1 | 1) => {
    if (reviewDiffs.length < 2 || activeReviewIndex < 0) return;
    const nextIndex = (activeReviewIndex + direction + reviewDiffs.length) % reviewDiffs.length;
    setDiffPanel(reviewDiffs[nextIndex]);
  };

  const copyReviewFilePath = async () => {
    if (!diffPanel || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(diffPanel.filePath);
      setDiffPathCopied(true);
      window.setTimeout(() => setDiffPathCopied(false), 1600);
    } catch {
      setDiffPathCopied(false);
    }
  };
  const activeQueuedPrompts = useMemo(
    () => (activeSession ? (queuedPromptsRef.current.get(activeSession.id) ?? []) : []),
    [activeSession, queueVersion]
  );
  const activeQueueLength = useMemo(
    () => activeQueuedPrompts.length,
    [activeQueuedPrompts]
  );
  const shellStyle = useMemo(
    () => ({ "--sidebar-width": `${sidebarWidth}px` }) as CSSProperties,
    [sidebarWidth]
  );
  const aiDraftId = useMemo(
    () => aiDraft.id.trim() || aiDraft.displayName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
    [aiDraft.displayName, aiDraft.id]
  );
  const aiDraftQuickConnect = AI_PROVIDER_QUICK_CONNECTS[aiDraftId];
  const isAiQuickConnect = Boolean(aiDraftQuickConnect);
  const aiDraftExistingProvider = aiProviders.find((provider) => provider.id === aiDraftId);
  const aiDraftCanSave = Boolean(
    aiDraftId &&
    aiDraft.baseUrl.trim() &&
    aiDraft.defaultModel.trim() &&
    (!isAiQuickConnect || aiDraft.apiKey.trim() || aiDraftExistingProvider?.configured)
  );
  const monitoredAiProviderIds = useMemo(
    () => new Set(aiProviders
      .filter((provider) => provider.enabled && provider.configured && !disabledAiProviderMonitoringIds.has(provider.id))
      .map((provider) => provider.id)),
    [aiProviders, disabledAiProviderMonitoringIds]
  );
  const monitoredAiProviderKey = useMemo(
    () => [...monitoredAiProviderIds].sort().join("\u0000"),
    [monitoredAiProviderIds]
  );

  useEffect(() => {
    if (selectedSettingsSection !== "usage") return;
    const node = usageActivityScrollRef.current;
    if (!node) return;
    node.scrollLeft = node.scrollWidth;
  }, [selectedSettingsSection, usageActivityMode, usageSummary?.daily?.length]);

  useEffect(() => {
    workspaceStateRef.current = workspaceState;
    localStorage.setItem(workspaceStorageKey, JSON.stringify(getPersistableWorkspaceState(workspaceState)));
  }, [workspaceState]);

  useEffect(() => {
    localStorage.setItem(sidebarCollapsedStorageKey, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(projectSessionCollapsedStorageKey, JSON.stringify(projectSessionCollapsed));
  }, [projectSessionCollapsed]);

  useEffect(() => {
    localStorage.setItem(aiDisabledProviderMonitoringStorageKey, JSON.stringify([...disabledAiProviderMonitoringIds]));
  }, [disabledAiProviderMonitoringIds]);

  useEffect(() => {
    localStorage.setItem("agent.themePreference", themePreference);
    void window.agentDesktop?.setThemePreference?.(themePreference);
  }, [themePreference]);

  useEffect(() => {
    void window.agentDesktop?.getThemePreference?.().then((saved) => {
      if (saved === "dark" || saved === "light" || saved === "system") {
        setThemePreference(saved);
        localStorage.setItem("agent.themePreference", saved);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (!themeTransitionRef.current) return;
      window.clearTimeout(themeTransitionRef.current.timeoutId);
      themeTransitionRef.current.overlay.remove();
      document.querySelector(".desktopShell")?.classList.remove("theme-transitioning");
      themeTransitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    void window.agentDesktop?.getLocalApiToken?.().then((token) => {
      if (token) setLocalApiToken(token);
    });
  }, []);

  useEffect(() => {
    if (!window.agentDesktop?.githubMcpAuthStatus || (isDesktopClient && !localApiToken)) return;
    void window.agentDesktop.githubMcpAuthStatus({ apiBase: API_BASE }).then(({ authorized }) => {
      setGithubMcpAuthorized(authorized);
      if (authorized) setMcpStatus((current) => ({ ...current, github: "浏览器授权已恢复" }));
    }).catch((error) => {
      setMcpStatus((current) => ({ ...current, github: `授权恢复失败：${error instanceof Error ? error.message : "未知错误"}` }));
    });
  }, [isDesktopClient, localApiToken]);

  useEffect(() => {
    if (isDesktopClient && !localApiToken) return;
    let disposed = false;

    const pollManagedProcesses = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/processes`, { headers: getLocalApiHeaders() });
        if (!response.ok) throw new Error("无法读取长期进程");
        const data = await response.json() as { processes?: ManagedProcessView[] };
        if (!disposed) {
          const processes = data.processes ?? [];
          setManagedProcesses(processes);
          setManagedProcessLoadError("");
          mergeManagedProcessSnapshots(processes, true);
        }
      } catch (error) {
        if (!disposed) setManagedProcessLoadError(error instanceof Error ? error.message : "无法读取长期进程");
      }
    };

    void pollManagedProcesses();
    const intervalId = window.setInterval(() => void pollManagedProcesses(), 1_500);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [isDesktopClient, localApiToken]);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((r) => r.json())
      .then((data) => {
        setHealth(data);
        setSelectedModel((cur) => cur || data.model || "");
      })
      .catch(() => setHealth(undefined));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/models`)
      .then((r) => r.json())
      .then((catalog: ModelCatalog) => {
        const recommended = catalog.recommendedForAgent ?? [];
        const all = catalog.models?.map((m) => m.id) ?? [];
        setModelOptions([...new Set([...recommended, ...all])]);
      })
      .catch(() => setModelOptions([]));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/permissions`)
      .then((r) => r.json())
      .then((catalog: PermissionCatalog) => {
        const defaults = new Map(defaultPermissionOptions.map((item) => [item.id, item]));
        const merged = (catalog.modes ?? defaultPermissionOptions).map((item) => ({
          id: item.id,
          label: defaults.get(item.id)?.label ?? item.id,
          description: item.description ?? defaults.get(item.id)?.description ?? ""
        }));
        setPermissionOptions(merged);
        if (catalog.defaultMode) {
          setMode(catalog.defaultMode);
        }
      })
      .catch(() => setPermissionOptions(defaultPermissionOptions));
  }, []);

  useEffect(() => {
    if (isDesktopClient && !localApiToken) return;
    const headers = getLocalApiHeaders();
    void Promise.all([
      fetch(`${API_BASE}/api/tools`, { headers }).then((r) => r.ok ? r.json() : { tools: [] }),
      fetch(`${API_BASE}/api/audit`, { headers }).then((r) => r.ok ? r.json() : { events: [] }),
      fetch(`${API_BASE}/api/usage`, { headers }).then((r) => r.ok ? r.json() : undefined),
      fetch(`${API_BASE}/api/ai/providers`, { headers }).then((r) => r.ok ? r.json() : { providers: [], activeProviderId: "" }),
      fetch(`${API_BASE}/api/mcp/servers`, { headers }).then((r) => r.ok ? r.json() : { servers: [] }),
      fetch(`${API_BASE}/api/skills${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { skills: [] }),
      fetch(`${API_BASE}/api/memory${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { memories: [] }),
      fetch(`${API_BASE}/api/learning${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { records: [] }),
      fetch(`${API_BASE}/api/agents${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { agents: [] })
    ]).then(([toolsData, auditData, usageData, aiData, mcpData, skillsData, memoryData, learningData, agentsData]) => {
      setToolCatalog(toolsData.tools ?? []);
      setAuditEvents(auditData.events ?? []);
      setUsageSummary(usageData);
      setAiProviders(aiData.providers ?? []);
      setAiActiveProviderId(aiData.activeProviderId ?? "");
      setMcpServers(mcpData.servers ?? []);
      setSkills(skillsData.skills ?? []);
      setMemories(memoryData.memories ?? []);
      setLearningRecords(learningData.records ?? []);
      setLatestLearningRun(learningData.lastRun);
      setSubagents(agentsData.agents ?? []);
    }).catch(() => {
      setToolCatalog([]);
      setAuditEvents([]);
      setUsageSummary(undefined);
      setAiProviders([]);
      setAiActiveProviderId("");
      setMcpServers([]);
      setSkills([]);
      setMemories([]);
      setLearningRecords([]);
      setLatestLearningRun(undefined);
      setSubagents([]);
    });
  }, [localApiToken, isDesktopClient, activeProject?.path]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!aiDraft.baseUrl.trim() || !aiDraft.apiKey.trim()) {
      setAiDraftModels([]);
      setAiDraftModelStatus("");
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void fetchAiDraftModels({ silent: true });
    }, 900);
    return () => window.clearTimeout(timeoutId);
  }, [aiDraft.baseUrl, aiDraft.apiKey, aiDraft.modelsPath]);

  useEffect(() => {
    if (!monitoredAiProviderKey || (isDesktopClient && !localApiToken)) return;
    const providerIds = monitoredAiProviderKey.split("\u0000").filter(Boolean);
    const checkEnabledProviders = () => {
      providerIds.forEach((id) => void checkAiProviderHealth(id));
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkEnabledProviders();
    };
    checkEnabledProviders();
    const intervalId = window.setInterval(checkEnabledProviders, aiRealtimeMonitorIntervalMs);
    window.addEventListener("focus", checkEnabledProviders);
    window.addEventListener("online", checkEnabledProviders);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", checkEnabledProviders);
      window.removeEventListener("online", checkEnabledProviders);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [isDesktopClient, localApiToken, monitoredAiProviderKey]);

  useEffect(() => {
    if (activeView !== "settings" || selectedSettingsSection !== "ai") return;
    if (isDesktopClient && !localApiToken) return;
    void loadAiProviderBalance(aiActiveProviderId);
  }, [activeView, aiActiveProviderId, isDesktopClient, localApiToken, selectedSettingsSection]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;
    const frameId = window.requestAnimationFrame(() => {
      // 直接滚动消息容器。末尾锚点的 scrollIntoView 在 Electron 的
      // 嵌套 grid/overflow 布局中有时不会带动正确的滚动层。
      messageList.scrollTo({
        top: messageList.scrollHeight,
        behavior: isActiveSessionRunning ? "smooth" : "auto"
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [workspaceState.activeSessionId, messages.length, pendingApprovals.length, isActiveSessionRunning]);

  useEffect(() => {
    if (runningSessionIds.size === 0) return undefined;
    const intervalId = window.setInterval(() => setTimerTick(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [runningSessionIds]);

  function setAiProviderBusyState(id: string, state?: "activate" | "delete" | "test") {
    setAiProviderBusy((cur) => {
      const next = { ...cur };
      if (state) next[id] = state; else delete next[id];
      return next;
    });
  }

  function updateSession(projectId: string, sessionId: string, updater: (session: ProjectSession) => ProjectSession) {
    setWorkspaceState((cur) => ({
      ...cur,
      projects: cur.projects.map((p) =>
        p.id === projectId
          ? { ...p, updatedAt: new Date().toISOString(), sessions: p.sessions.map((s) => (s.id === sessionId ? updater(s) : s)) }
          : p
      )
    }));
  }

  function selectProject(project: AgentProject) {
    const firstSession = project.sessions.find((session) => !session.archivedAt) ?? createSession();
    expandProjectSessions(project.id);
    setActiveView("chat");
    setWorkspaceState((cur) => ({
      ...cur,
      projects: cur.projects.map((item) =>
        item.id === project.id && !item.sessions.some((session) => !session.archivedAt)
          ? { ...item, sessions: [firstSession, ...item.sessions] }
          : item
      ),
      activeProjectId: project.id,
      activeSessionId: firstSession.id
    }));
  }

  function selectSession(projectId: string, sessionId: string) {
    resetSessionSwipe(sessionId);
    setActiveView("chat");
    setWorkspaceState((cur) => ({ ...cur, activeProjectId: projectId, activeSessionId: sessionId }));
  }

  function addProject(project: AgentProject) {
    expandProjectSessions(project.id);
    setWorkspaceState((cur) => {
      const regularProjects = cur.projects.filter((item) => item.kind !== "temporary");
      const temporaryProject = cur.projects.find((item) => item.kind === "temporary") ?? createTemporaryProject();
      return normalizeWorkspaceState({
        projects: [project, ...regularProjects, temporaryProject],
        activeProjectId: project.id,
        activeSessionId: project.sessions[0].id
      });
    });
  }

  async function addFolderProject() {
    const folderPath = await window.agentDesktop?.selectProjectFolder?.();
    if (!folderPath) return;
    addProject(createProject(getFolderName(folderPath), "folder", folderPath));
  }

  async function createNewProject() {
    const name = window.prompt("项目名称（默认存放在文稿）", "新项目");
    const trimmedName = name?.trim();
    if (!trimmedName) return;
    const folderPath = await window.agentDesktop?.createFolderProject?.(trimmedName);
    addProject(createProject(trimmedName, folderPath ? "folder" : "empty", folderPath));
  }

  function startTemporarySession() {
    const session = createSession("临时会话");
    expandProjectSessions(temporaryProjectId);
    setActiveView("chat");
    setWorkspaceState((cur) => {
      const temporaryProject = cur.projects.find((project) => project.kind === "temporary") ?? createTemporaryProject([]);
      const regularProjects = cur.projects.filter((project) => project.kind !== "temporary");
      return normalizeWorkspaceState({
        ...cur,
        projects: [
          ...regularProjects,
          { ...temporaryProject, sessions: [session, ...temporaryProject.sessions], updatedAt: session.updatedAt }
        ],
        activeProjectId: temporaryProjectId,
        activeSessionId: session.id
      });
    });
  }

  function addSession(projectId = workspaceState.activeProjectId) {
    const session = createSession();
    expandProjectSessions(projectId);
    setActiveView("chat");
    setWorkspaceState((cur) => ({
      ...cur,
      projects: cur.projects.map((p) =>
        p.id === projectId ? { ...p, updatedAt: session.updatedAt, sessions: [session, ...p.sessions] } : p
      ),
      activeProjectId: projectId,
      activeSessionId: session.id
    }));
  }

  function archiveSession(projectId: string, sessionId: string) {
    resetSessionSwipe(sessionId);
    queuedPromptsRef.current.delete(sessionId);
    abortControllersRef.current.get(sessionId)?.abort();
    abortControllersRef.current.delete(sessionId);
    setRunningSessionIds((cur) => {
      const next = new Set(cur);
      next.delete(sessionId);
      return next;
    });

    setWorkspaceState((cur) => {
      const project = cur.projects.find((item) => item.id === projectId);
      if (!project) return cur;

      const now = new Date().toISOString();
      const sessions = project.sessions.map((session) =>
        session.id === sessionId ? { ...session, archivedAt: now, updatedAt: now, pendingApprovals: [] } : session
      );
      const visibleSessions = sessions.filter((session) => !session.archivedAt);
      const fallbackSession = visibleSessions[0] ?? createSession();
      const nextSessions = visibleSessions.length > 0 ? sessions : [fallbackSession, ...sessions];

      return {
        ...cur,
        activeProjectId: cur.activeSessionId === sessionId ? projectId : cur.activeProjectId,
        activeSessionId: cur.activeSessionId === sessionId ? fallbackSession.id : cur.activeSessionId,
        projects: cur.projects.map((item) =>
          item.id === projectId ? { ...item, updatedAt: now, sessions: nextSessions } : item
        )
      };
    });
  }

  function expandProjectSessions(projectId: string) {
    setProjectSessionCollapsed((cur) => {
      if (!cur[projectId]) return cur;
      const next = { ...cur };
      delete next[projectId];
      return next;
    });
  }

  function toggleProjectSessions(projectId: string) {
    setProjectSessionCollapsed((cur) => {
      const next = { ...cur };
      if (next[projectId]) {
        delete next[projectId];
      } else {
        next[projectId] = true;
      }
      return next;
    });
  }

  function resetSessionSwipe(sessionId: string) {
    const state = sessionWheelSwipeRef.current.get(sessionId);
    if (state?.timeoutId) window.clearTimeout(state.timeoutId);
    sessionWheelSwipeRef.current.delete(sessionId);
    setSessionSwipeOffsets((cur) => {
      if (!cur[sessionId]) return cur;
      const next = { ...cur };
      delete next[sessionId];
      return next;
    });
  }

  function setSessionSwipeOffset(sessionId: string, offset: number) {
    const clamped = Math.max(0, Math.min(sessionArchiveSwipeMax, Math.round(offset)));
    const current = sessionWheelSwipeRef.current.get(sessionId) ?? { offset: 0 };
    sessionWheelSwipeRef.current.set(sessionId, { ...current, offset: clamped });
    setSessionSwipeOffsets((cur) => ({ ...cur, [sessionId]: clamped }));
  }

  function handleSessionWheel(projectId: string, sessionId: string, event: ReactWheelEvent<HTMLDivElement>) {
    const absX = Math.abs(event.deltaX);
    const absY = Math.abs(event.deltaY);
    if (absX < 4 || absX < absY * 1.15) return;

    event.preventDefault();
    event.stopPropagation();

    const current = sessionWheelSwipeRef.current.get(sessionId) ?? { offset: sessionSwipeOffsets[sessionId] ?? 0 };
    if (current.timeoutId) window.clearTimeout(current.timeoutId);

    const nextOffset = Math.max(0, Math.min(sessionArchiveSwipeMax, current.offset + event.deltaX));
    setSessionSwipeOffset(sessionId, nextOffset);

    const timeoutId = window.setTimeout(() => {
      const finalOffset = sessionWheelSwipeRef.current.get(sessionId)?.offset ?? 0;
      if (finalOffset >= sessionArchiveSwipeThreshold) {
        archiveSession(projectId, sessionId);
      } else {
        resetSessionSwipe(sessionId);
      }
    }, 160);
    sessionWheelSwipeRef.current.set(sessionId, { offset: nextOffset, timeoutId });
  }

  function getSessionContext(projectId: string, sessionId: string) {
    const project = workspaceStateRef.current.projects.find((item) => item.id === projectId);
    const session = project?.sessions.find((item) => item.id === sessionId);
    return project && session ? { project, session } : undefined;
  }

  function findProjectIdForSession(sessionId: string) {
    return workspaceStateRef.current.projects.find((p) => p.sessions.some((s) => s.id === sessionId))?.id;
  }

  function updateQueueState() {
    setQueueVersion((v) => v + 1);
  }

  function enqueuePrompt(sessionId: string, content: string, attachments: ComposerAttachment[] = []) {
    const q = queuedPromptsRef.current.get(sessionId) ?? [];
    queuedPromptsRef.current.set(sessionId, [...q, { id: createId("queue"), content, kind: "prompt", attachments }]);
    updateQueueState();
  }

  function removeQueuedPrompt(sessionId: string, queueId: string) {
    const next = (queuedPromptsRef.current.get(sessionId) ?? []).filter((item) => item.id !== queueId);
    if (next.length > 0) queuedPromptsRef.current.set(sessionId, next);
    else queuedPromptsRef.current.delete(sessionId);
    updateQueueState();
  }

  function guideQueuedPrompt(sessionId: string, queueId: string) {
    const q = queuedPromptsRef.current.get(sessionId) ?? [];
    const target = q.find((item) => item.id === queueId);
    if (!target) return;
    const rest = q.filter((item) => item.id !== queueId);
    queuedPromptsRef.current.set(sessionId, [{ ...target, kind: "guide" }, ...rest]);
    updateQueueState();
  }

  function dequeuePrompt(sessionId: string) {
    const q = queuedPromptsRef.current.get(sessionId) ?? [];
    const [next, ...rest] = q;
    if (rest.length > 0) queuedPromptsRef.current.set(sessionId, rest);
    else queuedPromptsRef.current.delete(sessionId);
    updateQueueState();
    return next;
  }

  function appendUserMessage(projectId: string, sessionId: string, content: string, attachments: ComposerAttachment[] = []) {
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: createId("message"), role: "user", content, attachments };
    updateSession(projectId, sessionId, (s) => ({
      ...s,
      title: s.title === "新会话" ? getSessionTitle(content || attachments[0]?.name || "附件") : s.title,
      updatedAt: now,
      messages: [...s.messages, userMessage]
    }));
  }

  function stopActiveResponse() {
    if (!activeSession) return;
    const controller = abortControllersRef.current.get(activeSession.id);
    controller?.abort();
    abortControllersRef.current.delete(activeSession.id);
    if (activeProject) {
      updateSession(activeProject.id, activeSession.id, (session) => ({
        ...session,
        workflowPhase: "stopped",
        workflowLabel: "已停止当前任务"
      }));
    }
    markSessionIdle(activeSession.id);
  }

  async function processQueuedPrompt(projectId: string, sessionId: string) {
    const next = dequeuePrompt(sessionId);
    if (!next) return false;
    const content =
      next.kind === "guide"
        ? `请把下面内容作为对当前会话/当前任务的引导和补充约束，优先参考，但不要机械复述：\n\n${next.content}`
        : next.content;
    await runAgentForSession(projectId, sessionId, content, true, next.content, undefined, next.attachments ?? []);
    return true;
  }

  async function processNextQueuedPrompt(preferredSessionId?: string) {
    if (!preferredSessionId) return;
    const pid = findProjectIdForSession(preferredSessionId);
    if (pid && (queuedPromptsRef.current.get(preferredSessionId)?.length ?? 0) > 0) {
      await processQueuedPrompt(pid, preferredSessionId);
    }
  }

  /** 消费 SSE 流并实时更新会话 */
  async function consumeSseStream(
    response: Response,
    projectId: string,
    sessionId: string,
    _initialAssistantId: string,
    responseStartedAt: number
  ) {
    let currentAssistantId = _initialAssistantId;
    const streamProjectPath = workspaceStateRef.current.projects.find((project) => project.id === projectId)?.path ?? "";
    let modelCallStartedAt = Date.now();
    // 每次工具调用完成后，下一个 text_delta 需要新起一行
    let needNewAssistantRow = false;
    // 编辑工具会把前置说明和最终交付拆成两条 assistant 消息。只有真正
    // 收到工具之后的文本，才可以承载最终的“已编辑文件”交付卡。
    // 否则（例如模型执行完工具后直接结束）主动创建一条稳定的交付消息。
    let hasPostToolAssistantResponse = false;
    // 当前 Agent 运行产生的文件变更，在最终回复上作为可审核交付物展示。
    const runDiffs = new Map<string, DiffResult>();
    let currentActiveSkills: string[] = [];

    const appendAssistantSegment = (
      messages: ChatMessage[],
      target: ChatMessage
    ): ChatMessage[] => [
      ...messages,
      {
        ...target,
        // The progress header belongs to the first assistant row while a run
        // is active. New rows created after tools must not pull it downward.
        showResponseMeta: false,
        responseStartedAt: undefined,
        responseCompletedAt: undefined,
        usage: undefined
      }
    ];

    const moveResponseMeta = (
      messages: ChatMessage[],
      sourceId: string,
      target: ChatMessage
    ): ChatMessage[] => {
      const source = messages.find((message) => message.showResponseMeta === true) ??
        messages.find((message) => message.id === sourceId);
      const usage = source?.usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        model: modelName,
        estimated: true
      };
      return [
        ...messages.map((message) =>
          message.id === source?.id
            ? {
                ...message,
                showResponseMeta: false,
                responseStartedAt: undefined,
                responseCompletedAt: undefined,
                usage: undefined
              }
            : message
        ),
        {
          ...target,
          showResponseMeta: true,
          responseStartedAt: source?.responseStartedAt ?? responseStartedAt,
          responseCompletedAt: target.responseCompletedAt ?? source?.responseCompletedAt,
          usage
        }
      ];
    };

    const moveResponseMetaToExisting = (
      messages: ChatMessage[],
      targetId: string,
      responseCompletedAt: number
    ): ChatMessage[] => {
      const source = messages.find((message) => message.showResponseMeta === true);
      if (!source || source.id === targetId) {
        return messages.map((message) =>
          message.id === targetId
            ? { ...message, responseCompletedAt }
            : message
        );
      }

      return messages.map((message) => {
        if (message.id === source.id) {
          return {
            ...message,
            showResponseMeta: false,
            responseStartedAt: undefined,
            responseCompletedAt: undefined,
            usage: undefined
          };
        }
        if (message.id === targetId) {
          return {
            ...message,
            showResponseMeta: true,
            responseStartedAt: source.responseStartedAt ?? responseStartedAt,
            responseCompletedAt,
            usage: source.usage
          };
        }
        return message;
      });
    };

    const finalizeAssistantMessage = (message: ChatMessage, now = Date.now()): ChatMessage => {
      const startedAt = message.startedAt ?? modelCallStartedAt;
      return {
        ...message,
        // Models often emit several line breaks immediately before a tool call.
        // They are transport padding, not visible message content, and would be
        // preserved by the bubble's `white-space: pre-wrap` styling.
        content: message.content.trimEnd(),
        isStreaming: false,
        startedAt,
        completedAt: message.completedAt ?? now,
        durationMs: message.durationMs ?? Math.max(0, now - startedAt)
      };
    };

    const attachCompletion = (
      status: Extract<MessageStatus, "completed" | "error">,
      fallbackContent: string,
      serverConversationId?: string
    ) => {
      const artifactDiffs = runDiffs.size > 0 ? [...runDiffs.values()] : undefined;
      const completionContent = fallbackContent || (status === "error" ? "任务执行时发生错误。" : "任务已完成。");
      const completedAt = Date.now();

      updateSession(projectId, sessionId, (session) => {
        // 一旦有成功编辑，最终交付必须位于工具调用之后。这样工具日志的
        // 展开/折叠和模型是否补充结语，都不会影响“审核”卡片的可见性。
        if (artifactDiffs?.length && !hasPostToolAssistantResponse) {
          const finalAssistantId = createId("message");
          const finalMessage: ChatMessage = {
            id: finalAssistantId,
            role: "assistant",
            content: completionContent,
            status,
            artifactDiffs,
            startedAt: modelCallStartedAt,
            completedAt,
            durationMs: Math.max(0, completedAt - modelCallStartedAt),
            responseCompletedAt: completedAt
          };
          const finalizedMessages = session.messages.map((message) =>
            message.id === currentAssistantId ? finalizeAssistantMessage(message, completedAt) : message
          );
          return {
            ...session,
            conversationId: serverConversationId || session.conversationId,
            pendingApprovals: [],
            messages: moveResponseMeta(finalizedMessages, currentAssistantId, finalMessage)
          };
        }

        const finalizedMessages = session.messages.map((message) =>
          message.id === currentAssistantId
            ? {
                ...finalizeAssistantMessage(message, completedAt),
                status,
                content: message.content || completionContent,
                artifactDiffs
              }
            : message
        );

        return {
          ...session,
          conversationId: serverConversationId || session.conversationId,
          pendingApprovals: [],
          messages: moveResponseMetaToExisting(finalizedMessages, currentAssistantId, completedAt)
        };
      });
    };

    for await (const event of parseSseStream(response)) {
      switch (event.type) {
        case "run_started":
          updateSession(projectId, sessionId, (s) => ({
            ...s,
            conversationId: event.conversationId || s.conversationId
          }));
          break;

        case "workflow_state":
          if (event.phase) {
            const isModelCallPhase = event.phase === "thinking" || event.phase === "planning";
            if (isModelCallPhase) {
              modelCallStartedAt = Date.now();
              if (needNewAssistantRow) {
                const newId = createId("message");
                currentAssistantId = newId;
                needNewAssistantRow = false;
                hasPostToolAssistantResponse = true;
                updateSession(projectId, sessionId, (s) => ({
                  ...s,
                  messages: appendAssistantSegment(
                    s.messages,
                    {
                      id: newId,
                      role: "assistant" as const,
                      content: "",
                      isStreaming: true,
                      startedAt: modelCallStartedAt
                    }
                  )
                }));
              } else {
                updateSession(projectId, sessionId, (s) => ({
                  ...s,
                  messages: s.messages.map((message) =>
                    message.id === currentAssistantId && !message.content.trim()
                      ? { ...message, isStreaming: true, startedAt: modelCallStartedAt }
                      : message
                  )
                }));
              }
            }
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              workflowPhase: event.phase,
              workflowLabel: event.label ?? s.workflowLabel
            }));
          }
          break;

        case "context_snapshot":
          if (event.snapshot) {
            currentActiveSkills = [...event.snapshot.activeSkills];
            updateSession(projectId, sessionId, (s) => ({ ...s, contextSnapshot: event.snapshot }));
          }
          break;

        case "task_plan":
          if (event.plan) {
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              taskPlan: event.plan,
              workflowPhase: "plan_ready",
              workflowLabel: `计划已就绪，共 ${event.plan!.steps.length} 步`
            }));
          }
          break;

        case "text_delta": {
          if (needNewAssistantRow) {
            // 新起一行 assistant 消息
            const newId = createId("message");
            currentAssistantId = newId;
            modelCallStartedAt = Date.now();
            needNewAssistantRow = false;
            hasPostToolAssistantResponse = true;
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: appendAssistantSegment(
                s.messages,
                { id: newId, role: "assistant" as const, content: event.content ?? "", isStreaming: true, startedAt: modelCallStartedAt }
              )
            }));
          } else {
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === currentAssistantId ? { ...m, content: m.content + event.content } : m
              )
            }));
          }
          break;
        }

        case "usage_progress":
        case "usage":
          if (event.usage) {
            const isEstimated = event.usage.estimated ?? false;
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((message) =>
                message.showResponseMeta
                  ? {
                      ...message,
                      usage: {
                        ...message.usage,
                        ...event.usage!,
                        model: event.model,
                        provider: event.provider,
                        estimated: message.usage?.billedTotalTokens !== undefined ? false : isEstimated
                      }
                    }
                  : message
              )
            }));
          }
          break;

        case "billing_usage":
          if (event.usage) {
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((message) =>
                message.showResponseMeta
                  ? {
                      ...message,
                      usage: {
                        ...(message.usage ?? {
                          promptTokens: 0,
                          completionTokens: 0,
                          totalTokens: 0
                        }),
                        billedPromptTokens: event.usage!.promptTokens,
                        billedCompletionTokens: event.usage!.completionTokens,
                        billedTotalTokens: event.usage!.totalTokens,
                        model: event.model,
                        provider: event.provider,
                        estimated: false
                      }
                    }
                  : message
              )
            }));
          }
          break;

        case "tool_call":
          if (event.toolCall) {
            const toolStatus = getRealtimeToolStatus(event.toolCall.name);
            // 标记当前 assistant 消息不再流式
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === currentAssistantId ? finalizeAssistantMessage(m) : m
              )
            }));
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              workflowPhase: toolStatus.phase,
              workflowLabel: toolStatus.label,
              messages: [
                ...s.messages,
                {
                  id: createId("message"),
                  role: "tool" as const,
                  content: "",
                  toolCallId: event.toolCall!.id,
                  toolName: event.toolCall!.name,
                  toolArgs: event.toolCall!.arguments,
                  activeSkills: [...currentActiveSkills],
                  status: "running" as const
                }
              ]
            }));
            // 即使工具没有返回后续的 text_delta，也要在完成时生成独立交付。
            hasPostToolAssistantResponse = false;
          }
          break;

        case "permission_decision":
          break;

        case "tool_result":
          if (event.result) {
            const resultDiff = event.result.diff ?? event.result.diffs?.[0];
            if (resultDiff && event.result.ok) {
              runDiffs.set(normalizeFilePath(resultDiff.filePath), resultDiff);
            }
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: (() => {
                let matched = false;
                return s.messages.map((m) => {
                  if (m.role !== "tool" || m.status !== "running") return m;
                  const isMatchingTool = m.toolCallId ? m.toolCallId === event.result!.toolCallId : !matched;
                  if (!isMatchingTool) return m;
                  matched = true;
                  return {
                    ...m,
                    content: event.result!.content,
                    toolResult: { ok: event.result!.ok, content: event.result!.content, process: event.result!.process },
                    diff: resultDiff,
                    status: "completed" as const
                  };
                });
              })()
            }));
            // 下一个 text_delta 需要新起一行
            needNewAssistantRow = true;
          }
          break;

        case "diff_created":
          if (event.diffs && event.diffs.length > 0) {
            event.diffs.forEach((diff) => runDiffs.set(normalizeFilePath(diff.filePath), diff));
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) => {
                if (!isEditToolName(m.toolName) || m.diff) return m;
                const rawPath = m.toolArgs?.path as string | undefined;
                const matched = event.diffs?.find((diff) => rawPath && normalizeFilePath(diff.filePath).endsWith(normalizeFilePath(rawPath)));
                return matched ? { ...m, diff: matched } : m;
              })
            }));
          }
          break;

        case "approval_required":
          {
          const responseCompletedAt = Date.now();
          updateSession(projectId, sessionId, (s) => ({
            ...s,
            conversationId: event.conversationId || s.conversationId,
            pendingApprovals: event.approvals ?? [],
            messages: s.messages.map((m) =>
              m.id === currentAssistantId
                ? {
                    ...finalizeAssistantMessage(m, responseCompletedAt),
                    status: "approval_required" as const,
                    content: m.content || "需要你批准后才能继续执行。",
                    responseCompletedAt: m.showResponseMeta ? responseCompletedAt : m.responseCompletedAt
                  }
                : m
            )
          }));
          break;
          }

        case "learning_result": {
          if (event.status && event.reason && event.createdAt) {
            setLatestLearningRun({
              status: event.status,
              reason: event.reason,
              recordsSaved: event.recordsSaved ?? 0,
              createdAt: event.createdAt,
              projectPath: streamProjectPath,
              conversationId: event.conversationId
            });
          }
          if ((event.recordsSaved ?? 0) > 0) {
            const headers = getLocalApiHeaders();
            void fetch(`${API_BASE}/api/learning?projectPath=${encodeURIComponent(streamProjectPath)}`, { headers })
              .then((result) => result.ok ? result.json() : undefined)
              .then((data) => {
                if (!data) return;
                setLearningRecords(data.records ?? []);
                setLatestLearningRun(data.lastRun);
              })
              .catch(() => undefined);
          }
          break;
        }

        case "completed":
          attachCompletion("completed", event.answer || "任务已完成。", event.conversationId);
          break;

        case "error":
          attachCompletion("error", event.message || "发生错误。", event.conversationId);
          break;
      }
    }
  }

  async function runAgentForSession(
    projectId: string,
    sessionId: string,
    content: string,
    addUserMessage = true,
    displayContent = content,
    modeOverride?: PermissionMode,
    attachments: ComposerAttachment[] = []
  ) {
    const context = getSessionContext(projectId, sessionId);
    if (!context) return;

    if (addUserMessage) appendUserMessage(projectId, sessionId, displayContent, attachments);

    const assistantMessageId = createId("message");
    const requestStartedAt = Date.now();
    updateSession(projectId, sessionId, (s) => ({
      ...s,
      updatedAt: new Date().toISOString(),
      workflowPhase: "preparing",
      workflowLabel: "正在准备上下文",
      messages: [...s.messages, {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        isStreaming: true,
        startedAt: requestStartedAt,
        showResponseMeta: true,
        responseStartedAt: requestStartedAt,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: modelName, estimated: true }
      }]
    }));

    const abortController = new AbortController();
    abortControllersRef.current.set(sessionId, abortController);
    markSessionRunning(sessionId);

    try {
      const result = await fetch(`${API_BASE}/api/agent/run`, {
        method: "POST",
        signal: abortController.signal,
        headers: getJsonHeaders(),
        body: JSON.stringify({
          prompt: content,
          mode: modeOverride ?? context.session.permissionMode ?? mode,
          conversationId: context.session.conversationId,
          model: modelName,
          thinkingMode,
          projectPath: context.project.path,
          attachments
        })
      });

      if (!result.ok) {
        const body = await result.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `请求失败（HTTP ${result.status}）`);
      }

      await consumeSseStream(result, projectId, sessionId, assistantMessageId, requestStartedAt);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        updateSession(projectId, sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.role === "assistant" && m.isStreaming
              ? {
                  ...m,
                  isStreaming: false,
                  status: "error" as const,
                  content: m.content ? `${m.content}\n\n已停止当前回复。` : "已停止当前回复。",
                  completedAt: Date.now(),
                  durationMs: Math.max(0, Date.now() - (m.startedAt ?? requestStartedAt))
                }
              : m
          )
        }));
      } else {
        updateSession(projectId, sessionId, (s) => ({
          ...s,
          workflowPhase: "failed",
          workflowLabel: "请求失败",
          messages: s.messages.map((m) =>
            m.role === "assistant" && m.isStreaming
              ? {
                  ...m,
                  isStreaming: false,
                  status: "error" as const,
                  content: m.content || (error instanceof Error ? error.message : "请求失败"),
                  completedAt: Date.now(),
                  durationMs: Math.max(0, Date.now() - (m.startedAt ?? requestStartedAt))
                }
              : m
          )
        }));
      }
    } finally {
      const settledAt = Date.now();
      updateSession(projectId, sessionId, (s) => ({
        ...s,
        messages: s.messages
          .filter((message) => !(message.role === "assistant" && message.isStreaming && !message.content.trim()))
          .map((message) => {
            const settledMessage = message.isStreaming
              ? {
                  ...message,
                  isStreaming: false,
                  completedAt: message.completedAt ?? settledAt,
                  durationMs: message.durationMs ?? Math.max(0, settledAt - (message.startedAt ?? requestStartedAt))
                }
              : message;
            return settledMessage.showResponseMeta
              ? { ...settledMessage, responseCompletedAt: settledMessage.responseCompletedAt ?? settledAt }
              : settledMessage;
          })
      }));
      if (abortControllersRef.current.get(sessionId) === abortController) abortControllersRef.current.delete(sessionId);
      markSessionIdle(sessionId);
      void reloadPlatformData();
      void processNextQueuedPrompt(sessionId);
    }
  }

  async function runAgent(nextPrompt = prompt) {
    const content = nextPrompt.trim();
    const attachments = nextPrompt === prompt ? composerAttachments : [];
    if ((!content && attachments.length === 0) || !activeProject || !activeSession) return;

    if (isActiveSessionRunning) {
      enqueuePrompt(activeSession.id, content, attachments);
      setPrompt("");
      setComposerAttachmentsBySession((current) => ({ ...current, [activeSession.id]: [] }));
      return;
    }

    setPrompt("");
    setComposerAttachmentsBySession((current) => ({ ...current, [activeSession.id]: [] }));
    await runAgentForSession(activeProject.id, activeSession.id, content, true, content, undefined, attachments);
  }

  async function decideApproval(approvalId: string, allow: boolean) {
    if (!activeProject || !activeSession || isActiveSessionRunning) return;

    const projectId = activeProject.id;
    const sessionId = activeSession.id;
    const assistantMessageId = createId("message");
    const requestStartedAt = Date.now();
    updateSession(projectId, sessionId, (s) => ({
      ...s,
      pendingApprovals: [],
      workflowPhase: "preparing",
      workflowLabel: "正在准备上下文",
      messages: [...s.messages, {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        isStreaming: true,
        startedAt: requestStartedAt,
        showResponseMeta: true,
        responseStartedAt: requestStartedAt,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: modelName, estimated: true }
      }]
    }));

    const abortController = new AbortController();
    abortControllersRef.current.set(sessionId, abortController);
    markSessionRunning(sessionId);

    try {
      const result = await fetch(`${API_BASE}/api/agent/approve`, {
        method: "POST",
        signal: abortController.signal,
        headers: getJsonHeaders(),
        body: JSON.stringify({
          approvalId,
          allow,
          mode: activeSession.permissionMode ?? mode,
          model: modelName,
          thinkingMode,
          projectPath: activeProject.path
        })
      });

      await consumeSseStream(result, projectId, sessionId, assistantMessageId, requestStartedAt);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        updateSession(projectId, sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.role === "assistant" && m.isStreaming
              ? {
                  ...m,
                  isStreaming: false,
                  status: "error" as const,
                  content: m.content || (error instanceof Error ? error.message : "请求失败"),
                  completedAt: Date.now(),
                  durationMs: Math.max(0, Date.now() - (m.startedAt ?? requestStartedAt))
                }
              : m
          )
        }));
      }
    } finally {
      const settledAt = Date.now();
      updateSession(projectId, sessionId, (s) => ({
        ...s,
        messages: s.messages
          .filter((message) => !(message.role === "assistant" && message.isStreaming && !message.content.trim()))
          .map((message) => {
            const settledMessage = message.isStreaming
              ? {
                  ...message,
                  isStreaming: false,
                  completedAt: message.completedAt ?? settledAt,
                  durationMs: message.durationMs ?? Math.max(0, settledAt - (message.startedAt ?? requestStartedAt))
                }
              : message;
            return settledMessage.showResponseMeta
              ? { ...settledMessage, responseCompletedAt: settledMessage.responseCompletedAt ?? settledAt }
              : settledMessage;
          })
      }));
      if (abortControllersRef.current.get(sessionId) === abortController) abortControllersRef.current.delete(sessionId);
      markSessionIdle(sessionId);
      void processNextQueuedPrompt(sessionId);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void runAgent();
  }

  function handleSendButtonClick() {
    if (isActiveSessionRunning) {
      stopActiveResponse();
      return;
    }
    void runAgent();
  }

  function changeSessionMode(nextMode: PermissionMode) {
    setMode(nextMode);
    if (activeProject && activeSession) {
      updateSession(activeProject.id, activeSession.id, (session) => ({ ...session, permissionMode: nextMode }));
    }
  }

  function startPlannedExecution() {
    if (!activeProject || !activeSession || !activeSession.taskPlan || isActiveSessionRunning) return;
    const projectId = activeProject.id;
    const sessionId = activeSession.id;
    const planText = activeSession.taskPlan.steps.map((step, index) => `${index + 1}. ${step.title}`).join("\n");
    changeSessionMode("workspace_write");
    updateSession(projectId, sessionId, (session) => ({
      ...session,
      permissionMode: "workspace_write",
      workflowPhase: "preparing",
      workflowLabel: "已确认计划，准备执行"
    }));
    void runAgentForSession(
      projectId,
      sessionId,
      `请开始执行刚刚确认的计划。按顺序实施并完成验证；如项目实际情况与计划冲突，请说明后做最小必要调整。\n\n${planText}`,
      true,
      "确认计划并开始执行",
      "workspace_write"
    );
  }

  function toggleSidebar() {
    sessionWheelSwipeRef.current.forEach((state) => {
      if (state.timeoutId) window.clearTimeout(state.timeoutId);
    });
    sessionWheelSwipeRef.current.clear();
    setSessionSwipeOffsets({});
    setSidebarCollapsed((collapsed) => !collapsed);
  }

  function setThemePreferenceWithTransition(nextPreference: ThemePreference, sourceElement?: HTMLElement | null) {
    const nextResolvedTheme = nextPreference === "system" ? systemTheme : nextPreference;
    if (nextPreference === themePreference) return;

    if (nextResolvedTheme === resolvedTheme || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setThemePreference(nextPreference);
      return;
    }

    if (themeTransitionRef.current) {
      window.clearTimeout(themeTransitionRef.current.timeoutId);
      themeTransitionRef.current.overlay.remove();
      themeTransitionRef.current = null;
    }

    const anchor = sourceElement ?? themeToggleRef.current;
    const rect = anchor?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : 48;
    const shell = document.querySelector(".desktopShell") as HTMLElement | null;

    const overlay = document.createElement("div");
    overlay.className = `themeRevealOverlay ${nextResolvedTheme === "light" ? "to-light" : "to-dark"}`;
    overlay.setAttribute("aria-hidden", "true");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const farthestX = Math.max(cx, vw - cx);
    const farthestY = Math.max(cy, vh - cy);
    const diameter = Math.hypot(farthestX, farthestY) * 2.16;
    const half = diameter / 2;

    overlay.style.width = `${diameter}px`;
    overlay.style.height = `${diameter}px`;
    overlay.style.left = `${cx - half}px`;
    overlay.style.top = `${cy - half}px`;
    document.body.appendChild(overlay);

    const finishTransition = () => {
      if (themeTransitionRef.current?.overlay !== overlay) return;
      if (shell) shell.classList.remove("theme-transitioning");
      window.clearTimeout(themeTransitionRef.current.timeoutId);
      overlay.remove();
      themeTransitionRef.current = null;
    };

    const timeoutId = window.setTimeout(finishTransition, 1100);
    themeTransitionRef.current = { overlay, timeoutId };

    const onPhase1End = () => {
      overlay.removeEventListener("animationend", onPhase1End);

      if (shell) {
        shell.classList.add("theme-transitioning");
        shell.dataset.theme = nextResolvedTheme;
      }

      flushSync(() => {
        setThemePreference(nextPreference);
      });

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          overlay.classList.add("fading");
          overlay.addEventListener("animationend", finishTransition, { once: true });
        });
      });
    };
    overlay.addEventListener("animationend", onPhase1End);
  }

  function handleThemeToggle(e: React.MouseEvent<HTMLButtonElement>) {
    const targetTheme = resolvedTheme === "dark" ? "light" : "dark";
    setThemePreferenceWithTransition(targetTheme, e.currentTarget);
  }

  function getLocalApiHeaders(): HeadersInit {
    return localApiToken ? { "x-agent-token": localApiToken } : {};
  }

  function getJsonHeaders(): HeadersInit {
    return { "content-type": "application/json", ...getLocalApiHeaders() };
  }

  async function refreshManagedProcesses() {
    try {
      const response = await fetch(`${API_BASE}/api/processes`, { headers: getLocalApiHeaders() });
      if (!response.ok) throw new Error("无法读取长期进程");
      const data = await response.json() as { processes?: ManagedProcessView[] };
      const processes = data.processes ?? [];
      setManagedProcesses(processes);
      setManagedProcessLoadError("");
      mergeManagedProcessSnapshots(processes, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取长期进程";
      setManagedProcessLoadError(message);
      throw error;
    }
  }

  function mergeManagedProcessSnapshots(processes: ManagedProcessView[], markMissing = false) {
    const snapshots = new Map(processes.map((process) => [process.id, process]));
    setWorkspaceState((current) => {
      let changed = false;
      const projects = current.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => ({
          ...session,
          messages: session.messages.map((message) => {
            const existing = message.toolResult?.process;
            if (!existing) return message;
            let next = snapshots.get(existing.id);
            if (!next && markMissing && existing.status === "running") {
              next = {
                ...existing,
                status: "failed",
                endedAt: new Date().toISOString(),
                outputVersion: existing.outputVersion + 1,
                output: `${existing.output}${existing.output.endsWith("\n") || !existing.output ? "" : "\n"}进程会话不可用；Rcode 服务可能已重启。\n`
              };
            }
            if (!next || (next.status === existing.status && next.outputVersion === existing.outputVersion && next.endedAt === existing.endedAt)) return message;
            changed = true;
            return { ...message, toolResult: { ...message.toolResult!, process: next } };
          })
        }))
      }));
      return changed ? { ...current, projects } : current;
    });
  }

  async function stopManagedProcess(processId: string) {
    const response = await fetch(`${API_BASE}/api/processes/${encodeURIComponent(processId)}/stop`, {
      method: "POST",
      headers: getJsonHeaders()
    });
    const data = await response.json().catch(() => ({})) as { process?: ManagedProcessView; error?: string };
    if (!response.ok || !data.process) throw new Error(data.error ?? "停止进程失败");
    setManagedProcesses((current) => current.map((process) => process.id === data.process!.id ? data.process! : process));
    mergeManagedProcessSnapshots([data.process]);
  }

  async function reloadPlatformData() {
    const headers = getLocalApiHeaders();
    const [mcpData, auditData, usageData, toolsData, aiData, skillsData, memoryData, learningData, agentsData] = await Promise.all([
      fetch(`${API_BASE}/api/mcp/servers`, { headers }).then((r) => r.ok ? r.json() : { servers: [] }),
      fetch(`${API_BASE}/api/audit`, { headers }).then((r) => r.ok ? r.json() : { events: [] }),
      fetch(`${API_BASE}/api/usage`, { headers }).then((r) => r.ok ? r.json() : undefined),
      fetch(`${API_BASE}/api/tools`, { headers }).then((r) => r.ok ? r.json() : { tools: [] }),
      fetch(`${API_BASE}/api/ai/providers`, { headers }).then((r) => r.ok ? r.json() : { providers: [], activeProviderId: "" }),
      fetch(`${API_BASE}/api/skills${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { skills: [] }),
      fetch(`${API_BASE}/api/memory${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { memories: [] }),
      fetch(`${API_BASE}/api/learning${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { records: [] }),
      fetch(`${API_BASE}/api/agents${activeProject?.path ? `?projectPath=${encodeURIComponent(activeProject.path)}` : ""}`, { headers }).then((r) => r.ok ? r.json() : { agents: [] })
    ]);
    setMcpServers(mcpData.servers ?? []);
    setAuditEvents(auditData.events ?? []);
    setUsageSummary(usageData);
    setToolCatalog(toolsData.tools ?? []);
    setAiProviders(aiData.providers ?? []);
    setAiActiveProviderId(aiData.activeProviderId ?? "");
    setSkills(skillsData.skills ?? []);
    setMemories(memoryData.memories ?? []);
    setLearningRecords(learningData.records ?? []);
    setLatestLearningRun(learningData.lastRun);
    setSubagents(agentsData.agents ?? []);
  }

  async function reloadRuntimeData() {
    const [healthData, modelData] = await Promise.all([
      fetch(`${API_BASE}/api/health`).then((r) => r.json()).catch(() => undefined),
      fetch(`${API_BASE}/api/models`).then((r) => r.json()).catch(() => undefined)
    ]);
    if (healthData) {
      setHealth(healthData);
      setSelectedModel(healthData.model || "");
    }
    if (modelData) {
      const recommended = modelData.recommendedForAgent ?? [];
      const all = modelData.models?.map((m: { id: string }) => m.id) ?? [];
      setModelOptions([...new Set([...recommended, ...all])]);
    }
  }

  async function loadAiProviderBalance(providerId = aiActiveProviderId) {
    const requestId = aiProviderBalanceRequestRef.current + 1;
    aiProviderBalanceRequestRef.current = requestId;
    if (!providerId) {
      setAiProviderBalance(undefined);
      setAiProviderBalanceLoading(false);
      return;
    }
    setAiProviderBalanceLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/ai/providers/${encodeURIComponent(providerId)}/balance`, {
        headers: getLocalApiHeaders()
      });
      const data = await response.json().catch(() => ({})) as AiProviderBalance;
      if (!response.ok) {
        throw new Error(data.error || "余额查询失败");
      }
      if (aiProviderBalanceRequestRef.current === requestId) setAiProviderBalance(data);
    } catch (error) {
      if (aiProviderBalanceRequestRef.current === requestId) {
        setAiProviderBalance({
          status: "unavailable",
          source: providerId,
          error: error instanceof Error ? error.message : "余额查询失败",
          checkedAt: new Date().toISOString()
        });
      }
    } finally {
      if (aiProviderBalanceRequestRef.current === requestId) setAiProviderBalanceLoading(false);
    }
  }

  function openAiQuickConnect(id: string) {
    const existing = aiProviders.find((provider) => provider.id === id);
    if (existing) {
      openEditAiProvider(existing);
      return;
    }
    const quickConnect = AI_PROVIDER_QUICK_CONNECTS[id];
    if (!quickConnect) return;
    setEditingAiProviderId(undefined);
    setAiDraft({
      id,
      displayName: quickConnect.displayName,
      baseUrl: quickConnect.baseUrl,
      apiKey: "",
      defaultModel: quickConnect.defaultModel,
      modelsPath: quickConnect.modelsPath,
      balancePath: quickConnect.balancePath ?? "",
      chatCompletionsPath: quickConnect.chatCompletionsPath,
      apiKeyEnv: quickConnect.apiKeyEnv,
      protocol: "openai-compatible"
    });
    setAiDraftModels([]);
    setAiDraftError("");
    setAiDraftModelStatus("填写密钥后即可保存并使用。");
    setShowAddProviderModal(true);
  }

  async function fetchAiDraftModels(options: { silent?: boolean } = {}) {
    setAiDraftError("");
    if (!aiDraft.baseUrl.trim()) {
      setAiDraftModelStatus("请先填写 URL");
      return;
    }
    if (!aiDraft.apiKey.trim()) {
      setAiDraftModelStatus("请填写密钥后获取模型");
      return;
    }
    setAiDraftFetchingModels(true);
    if (!options.silent) setAiDraftModelStatus("正在获取模型...");
    try {
      const response = await fetch(`${API_BASE}/api/ai/providers/models`, {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({
          id: aiDraft.id.trim() || "draft",
          displayName: aiDraft.displayName.trim() || "Draft provider",
          baseUrl: aiDraft.baseUrl.trim(),
          apiKey: aiDraft.apiKey.trim(),
          modelsPath: aiDraft.modelsPath.trim() || "/models",
          defaultModel: aiDraft.defaultModel.trim()
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "获取模型失败");
      if (data.error) throw new Error(data.error);
      const models = (data.models ?? []).map((model: { id: string }) => model.id).filter(Boolean);
      setAiDraftModels(models);
      setAiDraftModelStatus(models.length ? `已获取 ${models.length} 个模型` : "未发现模型，请检查 URL 或密钥权限");
      if (models.length && !models.includes(aiDraft.defaultModel)) {
        setAiDraft((cur) => ({ ...cur, defaultModel: models[0] }));
      }
    } catch (error) {
      setAiDraftModels([]);
      setAiDraftModelStatus(error instanceof Error ? error.message : "获取模型失败");
    } finally {
      setAiDraftFetchingModels(false);
    }
  }

  async function saveAiProviderFromDraft() {
    if (!aiDraftCanSave) {
      setAiDraftError(isAiQuickConnect ? `请填写 ${aiDraftQuickConnect.label} API Key。` : "请至少填写接口 ID/名称、Base URL 和默认模型。");
      return;
    }
    setAiDraftSaving(true);
    setAiDraftError("");
    try {
      const response = await fetch(`${API_BASE}/api/ai/providers`, {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({
          id: aiDraftId,
          displayName: aiDraft.displayName.trim() || aiDraftId,
          baseUrl: aiDraft.baseUrl.trim(),
          apiKey: aiDraft.apiKey.trim() || undefined,
          apiKeyEnv: aiDraft.apiKeyEnv.trim() || "AI_API_KEY",
          defaultModel: aiDraft.defaultModel.trim(),
          modelsPath: aiDraft.modelsPath.trim() || "/models",
          balancePath: aiDraft.balancePath.trim() || undefined,
          chatCompletionsPath: aiDraft.chatCompletionsPath.trim() || "/chat/completions",
          protocol: aiDraft.protocol || "openai-compatible",
          enabled: true
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "保存接口失败");
      if (editingAiProviderId === aiActiveProviderId || AI_PROVIDER_QUICK_CONNECTS[aiDraftId]) {
        const activateResponse = await fetch(`${API_BASE}/api/ai/providers/${encodeURIComponent(aiDraftId)}/activate`, {
          method: "POST",
          headers: getLocalApiHeaders()
        });
        if (!activateResponse.ok) {
          const activateData = await activateResponse.json().catch(() => ({}));
          throw new Error(typeof activateData.error === "string" ? activateData.error : "接口已保存，但启用失败");
        }
      }
      setAiDraft({ id: "", displayName: "", baseUrl: "", apiKey: "", defaultModel: "gpt-4o", modelsPath: "/models", balancePath: "", chatCompletionsPath: "/chat/completions", apiKeyEnv: "AI_API_KEY", protocol: "openai-compatible" });
      setAiDraftModels([]);
      setAiDraftModelStatus("");
      setShowAddProviderModal(false);
      setEditingAiProviderId(undefined);
      await Promise.all([reloadPlatformData(), reloadRuntimeData()]);
    } catch (error) {
      setAiDraftError(error instanceof Error ? error.message : "保存接口失败");
    } finally {
      setAiDraftSaving(false);
    }
  }

  function openNewAiProvider() {
    setEditingAiProviderId(undefined);
    setAiDraft({ id: "", displayName: "", baseUrl: "", apiKey: "", defaultModel: "gpt-4o", modelsPath: "/models", balancePath: "", chatCompletionsPath: "/chat/completions", apiKeyEnv: "AI_API_KEY", protocol: "openai-compatible" });
    setAiDraftModels([]);
    setAiDraftModelStatus("");
    setAiDraftError("");
    setShowAddProviderModal(true);
  }

  function openEditAiProvider(provider: AiProviderConfig) {
    setEditingAiProviderId(provider.id);
    setAiDraft({
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKey: "",
      defaultModel: provider.defaultModel,
      modelsPath: provider.modelsPath || "/models",
      balancePath: provider.balancePath || "",
      chatCompletionsPath: provider.chatCompletionsPath || "/chat/completions",
      apiKeyEnv: provider.apiKeyEnv || "AI_API_KEY",
      protocol: "openai-compatible"
    });
    setAiDraftModels([]);
    setAiDraftModelStatus(provider.configured ? "输入新密钥以替换当前密钥" : "请输入 API Key");
    setAiDraftError("");
    setShowAddProviderModal(true);
  }

  async function activateAiProvider(id: string) {
    setAiProviderBusyState(id, "activate");
    try {
      const response = await fetch(`${API_BASE}/api/ai/providers/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        headers: getLocalApiHeaders()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "切换接口失败");
      setAiProviderStatus((cur) => ({ ...cur, [id]: "已设为当前接口" }));
      await Promise.all([reloadPlatformData(), reloadRuntimeData()]);
    } catch (error) {
      setAiProviderStatus((cur) => ({ ...cur, [id]: error instanceof Error ? `失败：${error.message}` : "切换接口失败" }));
    } finally {
      setAiProviderBusyState(id);
    }
  }

  async function checkAiProviderHealth(id: string, showBusy = false) {
    if (aiProviderHealthChecksRef.current.has(id)) return;
    aiProviderHealthChecksRef.current.add(id);
    if (showBusy) setAiProviderBusyState(id, "test");
    setAiProviderHealth((cur) => ({ ...cur, [id]: { state: "checking" } }));
    setAiProviderStatus((cur) => ({ ...cur, [id]: "测试中..." }));
    try {
      const response = await fetch(`${API_BASE}/api/ai/providers/${encodeURIComponent(id)}/test`, {
        method: "POST",
        headers: getLocalApiHeaders()
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "测试失败");
      const checkedAt = Date.now();
      setAiProviderHealth((cur) => ({
        ...cur,
        [id]: { state: data.ok ? "healthy" : "unhealthy", checkedAt }
      }));
      setAiProviderStatus((cur) => ({
        ...cur,
        [id]: data.ok ? `连接正常，发现 ${data.modelCount ?? 0} 个模型` : `失败：${data.error ?? "无法连接"}`
      }));
    } catch (error) {
      setAiProviderHealth((cur) => ({ ...cur, [id]: { state: "unhealthy", checkedAt: Date.now() } }));
      setAiProviderStatus((cur) => ({ ...cur, [id]: `失败：${error instanceof Error ? error.message : "测试失败"}` }));
    } finally {
      aiProviderHealthChecksRef.current.delete(id);
      if (showBusy) setAiProviderBusyState(id);
    }
  }

  async function testAiProvider(id: string) {
    await checkAiProviderHealth(id, true);
  }

  function toggleAiProviderMonitoring(id: string) {
    setDisabledAiProviderMonitoringIds((current) => {
      const next = new Set(current);
      if (monitoredAiProviderIds.has(id)) {
        next.add(id);
        setAiProviderHealth((health) => ({ ...health, [id]: { state: "idle" } }));
      } else {
        next.delete(id);
        setAiProviderHealth((health) => ({ ...health, [id]: { state: "checking" } }));
      }
      return next;
    });
  }

  async function deleteAiProvider(id: string) {
    setAiProviderBusyState(id, "delete");
    try {
      const response = await fetch(`${API_BASE}/api/ai/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: getLocalApiHeaders()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "删除接口失败");
      setDisabledAiProviderMonitoringIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      await Promise.all([reloadPlatformData(), reloadRuntimeData()]);
    } catch (error) {
      setAiProviderStatus((cur) => ({ ...cur, [id]: error instanceof Error ? `失败：${error.message}` : "删除接口失败" }));
    } finally {
      setAiProviderBusyState(id);
    }
  }

  async function saveMcpServer(server: Partial<McpServerConfig>) {
    await fetch(`${API_BASE}/api/mcp/servers`, {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify(server)
    });
    await reloadPlatformData();
  }

  async function deleteMcpServer(id: string) {
    await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: getLocalApiHeaders()
    });
    await reloadPlatformData();
  }

  async function addMcpServerFromDraft() {
    const name = mcpDraft.name.trim();
    if (!name) return;
    const isHttp = Boolean(mcpDraft.url.trim());
    await saveMcpServer({
      name,
      transport: isHttp ? "http" : "stdio",
      url: isHttp ? mcpDraft.url.trim() : undefined,
      command: isHttp ? undefined : mcpDraft.command.trim(),
      args: [],
      enabled: true,
      defaultApproval: "ask"
    });
    setMcpDraft({ name: "", command: "", url: "" });
  }

  async function testMcpServer(id: string) {
    setMcpStatus((current) => ({ ...current, [id]: "连接测试中..." }));
    try {
      const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}/test`, {
        method: "POST",
        headers: getLocalApiHeaders()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "测试失败");
      setMcpStatus((current) => ({ ...current, [id]: `连接正常，发现 ${Array.isArray(data.tools) ? data.tools.length : 0} 个工具` }));
      await reloadPlatformData();
    } catch (error) {
      setMcpStatus((current) => ({ ...current, [id]: `失败：${error instanceof Error ? error.message : "测试失败"}` }));
    }
  }

  async function authorizeGithubMcp(server: McpServerConfig) {
    const clientId = (mcpOauthClientIds[server.id] ?? server.oauthClientId ?? "").trim();
    const clientSecret = githubOauthClientSecret.trim();
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) {
      setMcpStatus((current) => ({ ...current, [server.id]: "请先填写有效的 GitHub OAuth Client ID" }));
      return;
    }
    if (clientSecret.length < 8 || clientSecret.length > 256) {
      setMcpStatus((current) => ({ ...current, [server.id]: "请填写 GitHub OAuth Client Secret；它只用于本次 token 交换，不会保存" }));
      return;
    }
    if (!window.agentDesktop?.githubMcpAuthorize) {
      setMcpStatus((current) => ({ ...current, [server.id]: "浏览器 OAuth 仅在 Rcode 桌面客户端中可用" }));
      return;
    }
    setMcpStatus((current) => ({ ...current, [server.id]: "正在启动浏览器；授权完成后会自动返回 Rcode..." }));
    try {
      await saveMcpServer({ ...server, oauthClientId: clientId, enabled: true });
      const result = await window.agentDesktop.githubMcpAuthorize({ clientId, clientSecret, apiBase: API_BASE });
      setGithubMcpAuthorized(true);
      setMcpStatus((current) => ({ ...current, [server.id]: result.login ? `已授权 GitHub 用户 ${result.login}` : "GitHub 浏览器授权完成" }));
      await testMcpServer(server.id);
    } catch (error) {
      setMcpStatus((current) => ({ ...current, [server.id]: `授权失败：${error instanceof Error ? error.message : "未知错误"}` }));
    } finally {
      setGithubOauthClientSecret("");
    }
  }

  async function logoutGithubMcp(server: McpServerConfig) {
    if (!window.agentDesktop?.githubMcpLogout) return;
    try {
      await window.agentDesktop.githubMcpLogout({ apiBase: API_BASE });
      setGithubMcpAuthorized(false);
      await saveMcpServer({ ...server, enabled: false });
      setMcpStatus((current) => ({ ...current, [server.id]: "已撤销本机浏览器授权" }));
    } catch (error) {
      setMcpStatus((current) => ({ ...current, [server.id]: `撤销失败：${error instanceof Error ? error.message : "未知错误"}` }));
    }
  }

  async function removeLearningRecord(id: string) {
    if (!window.confirm("删除这条学习记录？后续任务将不再使用它。")) return;
    const response = await fetch(`${API_BASE}/api/learning/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: getLocalApiHeaders()
    });
    if (!response.ok) return;
    setLearningRecords((current) => current.filter((record) => record.id !== id));
  }

  async function openSkillDetail(skill: AgentSkill) {
    setSelectedSkill(skill);
    setSkillDetailContent("");
    setSkillDetailLoading(true);
    const params = new URLSearchParams({ path: skill.path });
    if (activeProject?.path) params.set("projectPath", activeProject.path);
    try {
      const response = await fetch(`${API_BASE}/api/skills/content?${params.toString()}`, { headers: getLocalApiHeaders() });
      const data = await response.json().catch(() => ({})) as { content?: string; error?: string };
      setSkillDetailContent(response.ok && data.content ? data.content : data.error ?? "无法读取 Skill 内容");
    } catch {
      setSkillDetailContent("无法读取 Skill 内容，请稍后重试。");
    } finally {
      setSkillDetailLoading(false);
    }
  }

  function openSettingsPage(section: SettingsSectionId = "general") {
    setSelectedSettingsSection(section);
    setActiveView("settings");
  }

  const settingsGroups: Array<{
    title: string;
    items: Array<{ id: SettingsSectionId; label: string; shortcut?: string }>;
  }> = [
    {
      title: "个人",
      items: [
        { id: "profile", label: "用户主页" },
        { id: "general", label: "常规" },
        { id: "usage", label: "使用情况和计费" }
      ]
    },
    {
      title: "集成",
      items: [
        { id: "ai", label: "AI 接口" },
        { id: "mcp", label: "MCP 服务器" }
      ]
    },
    {
      title: "智能",
      items: [
        { id: "skills", label: "Skill 库" },
        { id: "learning", label: "学习记录" }
      ]
    }
  ];
  const selectedSettingsItem =
    settingsGroups.flatMap((group) => group.items).find((item) => item.id === selectedSettingsSection) ??
    settingsGroups[0].items[0];
  const activeSettingsSection = selectedSettingsItem.id;

  function renderSettingsIcon(section: SettingsSectionId) {
    const size = 18;
    if (section === "profile") return <UserRound size={size} />;
    if (section === "general") return <Settings size={size} />;
    if (section === "usage") return <Brain size={size} />;
    if (section === "learning") return <Archive size={size} />;
    if (section === "skills") return <Puzzle size={size} />;
    if (section === "ai") return <SlidersHorizontal size={size} />;
    return <Terminal size={size} />;
  }

  function renderUsageActivityPanel(usage: UsageSummary) {
    const activity = buildUsageActivityGrid(usage.daily ?? [], usageActivityMode);
    const activeModeLabel =
      usageActivityMode === "weekly" ? "每周汇总" : usageActivityMode === "total" ? "累计 Token" : "每日 Token";
    return (
      <div className="usageActivityPanel">
        <div className="usageActivityHeader">
          <h4>Token 活动</h4>
          <div className="usageActivityTabs" role="tablist" aria-label="Token 活动范围">
            {([
              ["daily", "每日"],
              ["weekly", "每周"],
              ["total", "累计"]
            ] as Array<[UsageActivityMode, string]>).map(([modeId, label]) => (
              <button
                className={usageActivityMode === modeId ? "active" : ""}
                key={modeId}
                type="button"
                onClick={() => setUsageActivityMode(modeId)}
                role="tab"
                aria-selected={usageActivityMode === modeId}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
              <div className="usageHeatmapShell" ref={usageActivityScrollRef} aria-label={`Token 活动：${activeModeLabel}`}>
          <div className="usageHeatmapGrid">
            {activity.cells.map((cell) => (
              <span
                className={`usageHeatmapCell level${cell.level}`}
                key={cell.dateKey}
                title={`${cell.dateKey} · ${formatUsageNumber(cell.value)} token · ${formatUsageNumber(cell.calls)} 次调用`}
              />
            ))}
          </div>
          <div className="usageHeatmapMonths" aria-hidden="true">
            {activity.monthLabels.map((item) => (
              <span key={item.key} style={{ gridColumn: item.column }}>
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function renderSettingsContent() {
    if (activeSettingsSection === "profile") {
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection profileSection">
            <div className="settingsPaneHeader">
              <h3>用户主页</h3>
              <p>查看你的 Rcode 账号与登录身份。</p>
            </div>
            <div className="profileHero">
              <div className="accountAvatar profileHeroAvatar" aria-hidden="true">
                {authUser.displayName.slice(0, 2).toUpperCase()}
              </div>
              <div className="profileHeroIdentity">
                <strong>{authUser.displayName}</strong>
                <span>@{authUser.username}</span>
              </div>
            </div>
            <dl className="profileDetails">
              <div><dt>邮箱</dt><dd>{authUser.email}</dd></div>
              <div><dt>用户名</dt><dd>@{authUser.username}</dd></div>
              <div><dt>加入时间</dt><dd>{new Date(authUser.createdAt).toLocaleDateString("zh-CN")}</dd></div>
            </dl>
            <button className="profileSignOutButton" type="button" onClick={() => void logout()}>退出当前账号</button>
          </section>
        </div>
      );
    }

    if (activeSettingsSection === "general") {
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection">
            <div className="settingsPaneHeader">
              <h3>常规</h3>
              <p>常用工作区偏好。</p>
            </div>
            <div className="settingsRows">
              <div className="settingsRow">
                <span>
                  <strong>项目栏宽度</strong>
                  <small>{sidebarCollapsed ? "已折叠" : `${sidebarWidth}px`}</small>
                </span>
                <button type="button" onClick={toggleSidebar}>
                  {sidebarCollapsed ? "展开" : "折叠"}
                </button>
              </div>
              <div className="settingsRow">
                <span>
                  <strong>默认权限模式</strong>
                  <small>{selectedPermission.label}</small>
                </span>
                <button type="button" onClick={() => setMode("workspace_write")}>重置</button>
              </div>
            </div>
          </section>
        </div>
      );
    }

    if (activeSettingsSection === "skills") {
      const normalizedQuery = skillSearch.trim().toLocaleLowerCase();
      const visibleSkills = skills
        .filter((skill) => skillScope === "all" || skill.scope === skillScope)
        .filter((skill) => {
          if (!normalizedQuery) return true;
          return `${skill.name} ${skill.displayName ?? ""} ${skill.shortDescription ?? ""} ${skill.description}`
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        })
        .sort((a, b) => {
          const scopeOrder = { builtin: 0, project: 1, user: 2 };
          return scopeOrder[a.scope] - scopeOrder[b.scope] || (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, "zh-CN");
        });
      const builtinCount = skills.filter((skill) => skill.scope === "builtin").length;
      const detailBody = skillDetailContent.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection skillsLibrarySection">
            <div className="settingsPaneHeader skillsLibraryHeader">
              <div>
                <h3>Skill 库</h3>
                <p>预置常用开发工作流，并自动发现当前项目和用户目录中的 Skill；只在任务匹配时按需加载。</p>
              </div>
              <div className="skillsLibraryCount"><strong>{skills.length}</strong><span>可用</span></div>
            </div>
            <div className="skillsLibrarySummary">
              <div><strong>{builtinCount}</strong><span>内置预设</span></div>
              <div><strong>{skills.filter((skill) => skill.scope === "project").length}</strong><span>项目 Skill</span></div>
              <div><strong>{skills.filter((skill) => skill.scope === "user").length}</strong><span>用户 Skill</span></div>
              <p><Brain size={15} />按需触发，避免多个 Skill 同时占用上下文</p>
            </div>
            <div className="learningToolbar skillsLibraryToolbar">
              <label className="learningSearchField">
                <Search size={15} aria-hidden="true" />
                <input
                  aria-label="搜索 Skill"
                  value={skillSearch}
                  onChange={(event) => setSkillSearch(event.target.value)}
                  placeholder="搜索名称、用途或关键词…"
                />
              </label>
              <select
                aria-label="按来源筛选 Skill"
                value={skillScope}
                onChange={(event) => setSkillScope(event.target.value as AgentSkill["scope"] | "all")}
              >
                <option value="all">全部来源</option>
                <option value="builtin">内置预设</option>
                <option value="project">当前项目</option>
                <option value="user">用户</option>
              </select>
            </div>
            <div className="skillsLibraryLayout">
              <div className="skillsCatalogList" aria-label="Skill 列表">
                {visibleSkills.length === 0 ? (
                  <div className="skillsCatalogEmpty">没有匹配的 Skill</div>
                ) : visibleSkills.map((skill) => (
                  <button
                    className={`skillsCatalogItem ${selectedSkill?.path === skill.path ? "active" : ""}`}
                    key={skill.path}
                    type="button"
                    onClick={() => void openSkillDetail(skill)}
                  >
                    <span className="skillsCatalogIcon"><Puzzle size={16} /></span>
                    <span className="skillsCatalogCopy">
                      <strong>{skill.displayName ?? skill.name}</strong>
                      <small>{skill.shortDescription ?? skill.description}</small>
                      <span><code>${skill.name}</code><b className={skill.scope}>{skillScopeLabels[skill.scope]}</b></span>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
              {selectedSkill && (
                <div className="skillDetailOverlay" role="presentation" onClick={() => setSelectedSkill(undefined)}>
                  <aside className="skillDetailPanel" aria-live="polite" onClick={(event) => event.stopPropagation()}>
                    <header>
                      <span className="skillsCatalogIcon"><Puzzle size={17} /></span>
                      <span>
                        <strong>{selectedSkill.displayName ?? selectedSkill.name}</strong>
                        <small>{skillScopeLabels[selectedSkill.scope]} · ${selectedSkill.name}</small>
                      </span>
                      <button className="skillDetailClose" type="button" onClick={() => setSelectedSkill(undefined)} aria-label="关闭 Skill 详情">
                        <X size={15} />
                      </button>
                    </header>
                    <p className="skillDetailDescription">{selectedSkill.shortDescription ?? selectedSkill.description}</p>
                    {selectedSkill.defaultPrompt && (
                      <div className="skillPromptExample">
                        <span>推荐调用</span>
                        <p>{selectedSkill.defaultPrompt}</p>
                        <button type="button" onClick={() => void navigator.clipboard.writeText(selectedSkill.defaultPrompt ?? "")}>
                          <Copy size={13} />复制
                        </button>
                      </div>
                    )}
                    <div className="skillInstructionHeader"><span>完整指令</span><code>SKILL.md</code></div>
                    <pre className="skillInstructionBody">{skillDetailLoading ? "正在读取…" : detailBody}</pre>
                  </aside>
                </div>
              )}
            </div>
          </section>
        </div>
      );
    }

    if (activeSettingsSection === "learning") {
      const normalizedQuery = learningSearch.trim().toLocaleLowerCase();
      const visibleLearningRecords = learningRecords.filter((record) => {
        if (learningCategory !== "all" && record.category !== learningCategory) return false;
        if (!normalizedQuery) return true;
        return `${record.title} ${record.insight} ${record.evidence ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
      });
      const autoLearningSkill = skills.find((skill) => skill.name === "auto-learning");
      const learningStatusTitle = !autoLearningSkill
        ? "自动学习 skill 未找到"
        : latestLearningRun?.status === "failed"
          ? "自动学习最近执行失败"
          : "自动学习已启用";
      const learningStatusDetail = !autoLearningSkill
        ? "请检查 ~/.agent/skills/auto-learning"
        : latestLearningRun
          ? `${new Date(latestLearningRun.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${latestLearningRun.reason}`
          : "任务完成后会独立核验；只有经过验证且可复用的经验才会保存";
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection learningSection">
            <div className="settingsPaneHeader learningHeader">
              <div>
                <h3>学习记录</h3>
                <p>Rcode 会在任务验证完成后沉淀可复用经验，并在后续任务中自动参考。</p>
              </div>
              <button className="learningRefreshButton" type="button" onClick={() => void reloadPlatformData()} aria-label="刷新学习记录">
                <RefreshCw size={14} />
                刷新
              </button>
            </div>
            <div className="learningStatusPanel">
              <span className={`learningStatusIcon ${autoLearningSkill ? "active" : ""}`} aria-hidden="true">
                <Brain size={20} />
              </span>
              <span>
                <strong>{learningStatusTitle}</strong>
                <small>{learningStatusDetail}</small>
              </span>
              <b>{learningRecords.length}</b>
            </div>
            <div className="learningToolbar">
              <label className="learningSearchField">
                <Search size={15} aria-hidden="true" />
                <input
                  aria-label="搜索学习记录"
                  value={learningSearch}
                  onChange={(event) => setLearningSearch(event.target.value)}
                  placeholder="搜索经验、验证依据…"
                />
              </label>
              <select
                aria-label="按类型筛选学习记录"
                value={learningCategory}
                onChange={(event) => setLearningCategory(event.target.value as LearningCategory | "all")}
              >
                <option value="all">全部类型</option>
                {(Object.entries(learningCategoryLabels) as Array<[LearningCategory, string]>).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="learningRecordList">
              {visibleLearningRecords.length === 0 ? (
                <div className="learningEmptyState">
                  <Brain size={24} aria-hidden="true" />
                  <strong>{learningRecords.length === 0 ? "还没有学习记录" : "没有匹配的记录"}</strong>
                  <p>{learningRecords.length === 0 ? (latestLearningRun?.reason ?? "完成一次有可复用经验的任务后，记录会自动出现在这里。") : "换一个关键词或筛选类型试试。"}</p>
                </div>
              ) : visibleLearningRecords.map((record) => (
                <article className="learningRecord" key={record.id}>
                  <header>
                    <span className={`learningCategoryBadge ${record.category}`}>{learningCategoryLabels[record.category]}</span>
                    <time dateTime={record.updatedAt}>{new Date(record.updatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                    <button type="button" onClick={() => void removeLearningRecord(record.id)} aria-label={`删除学习记录：${record.title}`}>
                      <Trash2 size={14} />
                    </button>
                  </header>
                  <h4>{record.title}</h4>
                  <p>{record.insight}</p>
                  {record.evidence && <small><strong>验证</strong>{record.evidence}</small>}
                  <footer>
                    <span>重要度 {record.importance}/5</span>
                    <span>{record.projectPath === activeProject?.path ? "当前项目" : record.projectPath.split("/").filter(Boolean).pop()}</span>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        </div>
      );
    }

    if (activeSettingsSection === "ai") {
      const activeProvider = aiProviders.find((provider) => provider.id === aiActiveProviderId || provider.active);
      const configuredProviders = aiProviders.filter((provider) => provider.configured).length;
      const missingProviders = aiProviders.length - configuredProviders;
      const quickConnects = Object.entries(AI_PROVIDER_QUICK_CONNECTS).filter(([id]) => {
        const existing = aiProviders.find((provider) => provider.id === id);
        return !existing?.configured;
      });
      const primaryBalance = aiProviderBalance?.balances?.[0];
      const balanceValue = aiProviderBalanceLoading
        ? "查询中"
        : aiProviderBalance?.status === "available" && primaryBalance
          ? formatBalanceAmount(primaryBalance.currency, primaryBalance.amount)
          : aiProviderBalance?.status === "unlimited"
            ? "不限额"
            : aiProviderBalance?.status === "unsupported"
              ? "未提供"
              : aiProviderBalance?.status === "unavailable"
                ? "暂不可用"
                : "等待查询";
      const balanceHint = aiProviderBalanceLoading
        ? `正在连接 ${activeProvider?.displayName ?? "当前上游"}`
        : aiProviderBalance?.status === "available" && primaryBalance
          ? primaryBalance.grantedAmount !== undefined || primaryBalance.toppedUpAmount !== undefined
            ? `赠金 ${formatBalanceAmount(primaryBalance.currency, primaryBalance.grantedAmount ?? 0)} · 充值 ${formatBalanceAmount(primaryBalance.currency, primaryBalance.toppedUpAmount ?? 0)}`
            : aiProviderBalance.balances && aiProviderBalance.balances.length > 1
              ? `另有 ${aiProviderBalance.balances.length - 1} 个币种余额`
              : "上游账户实时余额"
          : aiProviderBalance?.reason ?? aiProviderBalance?.error ?? "切换接口后自动查询";
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection aiProviderSection">
            <div className="aiProviderPageIntro">
              <p>配置 OpenAI-compatible 模型服务，并切换当前 Agent 使用的接口。</p>
              <button className="settingsBtnPrimary" type="button" onClick={openNewAiProvider}>
                <Plus size={15} />
                添加接口
              </button>
            </div>
            <div className="aiModuleCard aiProviderOverviewCard">
              <div className="aiModuleHeader">
                <span>
                  <strong>接口概览</strong>
                  <small>当前 Agent 的模型、密钥与账户状态</small>
                </span>
              </div>
              <div className="aiProviderSummary">
                <div>
                  <span>当前接口</span>
                  <strong>{activeProvider?.displayName ?? "未选择"}</strong>
                  <small>{activeProvider?.defaultModel ?? health?.model ?? "等待配置模型"}</small>
                </div>
                <div>
                  <span>可用密钥</span>
                  <strong>{configuredProviders}/{aiProviders.length}</strong>
                  <small>{missingProviders > 0 ? `${missingProviders} 个接口缺少密钥` : "所有接口均可测试"}</small>
                </div>
                <div>
                  <span>模型候选</span>
                  <strong>{modelOptions.length || 0}</strong>
                  <small>{health?.providerConfigured ? "聊天栏可直接切换" : "配置密钥后刷新"}</small>
                </div>
                <div className={`aiProviderBalanceMetric ${aiProviderBalance?.status ?? "idle"}`}>
                  <span className="aiProviderBalanceLabel">
                    账号余额
                    <button
                      type="button"
                      aria-label="刷新当前接口账号余额"
                      title="调用上游接口刷新余额"
                      onClick={() => void loadAiProviderBalance()}
                      disabled={!aiActiveProviderId || aiProviderBalanceLoading}
                    >
                      <RefreshCw size={12} className={aiProviderBalanceLoading ? "spinning" : ""} />
                    </button>
                  </span>
                  <strong title={balanceValue}>{balanceValue}</strong>
                  <small title={balanceHint}>{balanceHint}</small>
                </div>
              </div>
            </div>
            {quickConnects.length > 0 && (
              <div className="aiModuleCard aiQuickConnectCard">
                <div className="aiPresetLauncher">
                  <span className="aiPresetLauncherCopy">
                    <strong>快速接入</strong>
                    <small>官方参数已填好，只需填写 API Key</small>
                  </span>
                  <div className="aiPresetLauncherList">
                    {quickConnects.map(([id, quickConnect]) => {
                      return (
                        <button
                          className="aiPresetChip"
                          key={id}
                          type="button"
                          style={{ "--provider-accent": quickConnect.accent } as CSSProperties}
                          onClick={() => openAiQuickConnect(id)}
                        >
                          <span className="providerPresetMark" aria-hidden="true">{quickConnect.mark}</span>
                          {quickConnect.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <div className="aiModuleCard aiProviderDirectoryCard">
              <div className="aiProviderMonitorToolbar">
                <span className="aiProviderMonitorCopy">
                  <strong>接口与实时监测</strong>
                  <small>{monitoredAiProviderIds.size > 0 ? `${monitoredAiProviderIds.size} 个接口 · 不消耗 Token` : "点击接口左侧圆点开启"}</small>
                </span>
                <span className="aiProviderMonitorLegend" aria-label="状态颜色说明">
                  <span><i className="healthy" />正常</span>
                  <span><i className="checking" />检测中</span>
                  <span><i className="unhealthy" />异常</span>
                </span>
              </div>
              <div className="settingsRows aiProviderList">
              {aiProviders.length === 0 && (
                <div className="settingsRow">
                  <span>
                    <strong>暂无接口</strong>
                    <small>点击上方「添加接口」按钮新建，或通过 config/providers.json 配置内置接口。</small>
                  </span>
                </div>
              )}
              {aiProviders.map((provider) => {
                const isActiveProvider = provider.id === aiActiveProviderId || provider.active;
                const isMonitoring = monitoredAiProviderIds.has(provider.id);
                const healthState = isMonitoring ? aiProviderHealth[provider.id]?.state ?? "checking" : "idle";
                const statusText = aiProviderStatus[provider.id];
                const healthLabel = healthState === "healthy"
                  ? "正常"
                  : healthState === "unhealthy"
                    ? "异常"
                    : healthState === "checking"
                      ? "检测中"
                      : "未开启";
                return (
                  <div className={`settingsRow aiProviderRow ${isActiveProvider ? "aiProviderActive" : ""}`} key={provider.id}>
                    <div className="aiProviderSelectCell">
                      <button
                        aria-label={`${isMonitoring ? "关闭" : "开启"} ${provider.displayName} 状态监测，当前${healthLabel}`}
                        aria-pressed={isMonitoring}
                        className={`aiProviderStateDot ${healthState}`}
                        onClick={() => toggleAiProviderMonitoring(provider.id)}
                        title={`${healthLabel} · 点击${isMonitoring ? "关闭" : "开启"}实时监测`}
                        type="button"
                      />
                    </div>
                    <span className="aiProviderInfo">
                      <strong className="aiProviderTitle">
                        <span className="aiProviderName">{provider.displayName}</span>
                        {isActiveProvider ? <span className="aiProviderBadge">当前</span> : ""}
                        {provider.source === "builtin"
                          ? <span className="aiProviderBadgeBuiltin">内置</span>
                          : AI_PROVIDER_QUICK_CONNECTS[provider.id]
                            ? <span className="aiProviderBadgeBuiltin">快捷</span>
                            : ""}
                        <span className={`aiProviderBadgeSoft ${provider.configured ? "ready" : "missing"}`}>
                          {provider.configured ? "密钥已配置" : "缺少密钥"}
                        </span>
                      </strong>
                      <small className="aiProviderMeta">{provider.id} · {provider.defaultModel}</small>
                      <small className="aiProviderEndpoint">{provider.baseUrl}</small>
                      {statusText ? (
                        <small className={`aiProviderStatusLine ${statusText.includes("失败") || statusText.includes("required") ? "error" : statusText.includes("测试中") ? "testing" : "ok"}`}>
                          {statusText}
                        </small>
                      ) : null}
                    </span>
                    <div className="aiProviderActions">
                      <button className="aiProviderActionButton" type="button" onClick={() => openEditAiProvider(provider)} disabled={Boolean(aiProviderBusy[provider.id])}>
                        {provider.configured ? "配置" : "填写密钥"}
                      </button>
                      <button className="aiProviderActionButton" type="button" onClick={() => void testAiProvider(provider.id)} disabled={Boolean(aiProviderBusy[provider.id])}>
                        {aiProviderBusy[provider.id] === "test" ? "测试中" : "测试"}
                      </button>
                      <button className="aiProviderActionButton primary" type="button" onClick={() => void activateAiProvider(provider.id)} disabled={isActiveProvider || Boolean(aiProviderBusy[provider.id])}>
                        {isActiveProvider ? "使用中" : aiProviderBusy[provider.id] === "activate" ? "切换中" : "设为当前"}
                      </button>
                      {provider.source === "user" && (
                        <button className="aiProviderActionButton danger" type="button" onClick={() => void deleteAiProvider(provider.id)} disabled={Boolean(aiProviderBusy[provider.id])}>删除</button>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </section>

          {showAddProviderModal && (
            <div className="modalOverlay" onClick={() => { setShowAddProviderModal(false); setEditingAiProviderId(undefined); }}>
              <div className={`modalContent${isAiQuickConnect ? " aiPresetModal" : ""}`} onClick={(e) => e.stopPropagation()}>
                <div className="modalHeader">
                  <h3>{isAiQuickConnect ? `连接 ${aiDraftQuickConnect.label}` : editingAiProviderId ? "配置 AI 接口" : "添加 AI 接口"}</h3>
                  <button className="modalClose" onClick={() => { setShowAddProviderModal(false); setEditingAiProviderId(undefined); }}>&times;</button>
                </div>
                <div className="modalBody">
                  {isAiQuickConnect ? (
                    <div className="aiPresetIntro" style={{ "--provider-accent": aiDraftQuickConnect.accent } as CSSProperties}>
                      <span className="providerPresetMark" aria-hidden="true">{aiDraftQuickConnect.mark}</span>
                      <span>
                        <strong>{aiDraftQuickConnect.label} 快捷接入</strong>
                        <small>接口地址与推荐模型已填好，只需粘贴 API Key。</small>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="aiFormField">
                        <label>协议类型</label>
                        <select value={aiDraft.protocol} onChange={(e) => setAiDraft((cur) => ({ ...cur, protocol: e.target.value }))}>
                          <option value="openai-compatible">OpenAI-compatible (推荐)</option>
                        </select>
                      </div>
                      <div className="aiFormRow">
                        <div className="aiFormField">
                          <label>接口 ID</label>
                          <input value={aiDraft.id} disabled={Boolean(editingAiProviderId)} onChange={(e) => setAiDraft((cur) => ({ ...cur, id: e.target.value }))} placeholder="如 deepseek" />
                        </div>
                        <div className="aiFormField">
                          <label>显示名称</label>
                          <input value={aiDraft.displayName} onChange={(e) => setAiDraft((cur) => ({ ...cur, displayName: e.target.value }))} placeholder="显示名称" />
                        </div>
                      </div>
                      <div className="aiFormField">
                        <label>Base URL</label>
                        <input value={aiDraft.baseUrl} onChange={(e) => setAiDraft((cur) => ({ ...cur, baseUrl: e.target.value }))} placeholder="https://api.openai.com/v1" />
                      </div>
                    </>
                  )}
                  <div className="aiFormField">
                    <label>API Key</label>
                    <input
                      autoFocus={isAiQuickConnect}
                      type="password"
                      value={aiDraft.apiKey}
                      onChange={(e) => setAiDraft((cur) => ({ ...cur, apiKey: e.target.value }))}
                      placeholder={aiDraftExistingProvider?.configured
                        ? "输入新的 API Key（留空则保留原密钥）"
                        : isAiQuickConnect
                          ? `粘贴 ${aiDraftQuickConnect.label} API Key`
                          : "sk-..."}
                    />
                  </div>
                  {!isAiQuickConnect && <div className="aiModelDiscovery">
                    <span>
                      <strong>模型发现</strong>
                      <small>{aiDraftModelStatus || "填写 Base URL 和 API Key 后可获取模型列表"}</small>
                    </span>
                    <button type="button" className="settingsBtnSecondary" onClick={() => void fetchAiDraftModels()} disabled={aiDraftFetchingModels || !aiDraft.baseUrl.trim() || !aiDraft.apiKey.trim()}>
                      <RefreshCw size={14} />
                      {aiDraftFetchingModels ? "获取中" : "获取模型"}
                    </button>
                  </div>}
                  {isAiQuickConnect && (
                    <div className="aiPresetReadyLine">
                      <Check size={15} aria-hidden="true" />
                      保存后自动设为当前接口
                    </div>
                  )}
                  <details className={isAiQuickConnect ? "aiAdvancedSettings" : "aiAdvancedSettings open"} open={!isAiQuickConnect}>
                    {isAiQuickConnect && <summary>高级设置</summary>}
                    <div className="aiAdvancedSettingsBody">
                  {isAiQuickConnect && (
                    <div className="aiFormField">
                      <label>Base URL</label>
                      <input value={aiDraft.baseUrl} onChange={(e) => setAiDraft((cur) => ({ ...cur, baseUrl: e.target.value }))} />
                    </div>
                  )}
                  <div className="aiFormRow">
                    <div className="aiFormField">
                      <label>默认模型</label>
                      {aiDraftModels.length > 0 ? (
                        <select value={aiDraft.defaultModel} onChange={(e) => setAiDraft((cur) => ({ ...cur, defaultModel: e.target.value }))}>
                          {aiDraftModels.map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                      ) : (
                        <input value={aiDraft.defaultModel} onChange={(e) => setAiDraft((cur) => ({ ...cur, defaultModel: e.target.value }))} placeholder="gpt-4o" />
                      )}
                    </div>
                    <div className="aiFormField">
                      <label>环境变量名</label>
                      <input value={aiDraft.apiKeyEnv} onChange={(e) => setAiDraft((cur) => ({ ...cur, apiKeyEnv: e.target.value }))} placeholder="AI_API_KEY" />
                    </div>
                  </div>
                  <div className="aiFormRow">
                    <div className="aiFormField">
                      <label>Chat 路径</label>
                      <input value={aiDraft.chatCompletionsPath} onChange={(e) => setAiDraft((cur) => ({ ...cur, chatCompletionsPath: e.target.value }))} placeholder="/chat/completions" />
                    </div>
                    <div className="aiFormField">
                      <label>模型列表路径</label>
                      <input value={aiDraft.modelsPath} onChange={(e) => setAiDraft((cur) => ({ ...cur, modelsPath: e.target.value }))} placeholder="/models" />
                    </div>
                  </div>
                  <div className="aiFormField">
                    <label>余额接口（可选）</label>
                    <input
                      value={aiDraft.balancePath}
                      onChange={(e) => setAiDraft((cur) => ({ ...cur, balancePath: e.target.value }))}
                      placeholder="相对 Base URL 的路径或完整 URL"
                    />
                    <small>DeepSeek 与 OpenRouter 可自动识别；其他上游可在此填写只读余额接口。</small>
                  </div>
                    </div>
                  </details>
                  {aiDraftError ? <div className="aiFormError">{aiDraftError}</div> : null}
                </div>
                <div className="modalFooter">
                  <button type="button" className="settingsBtnSecondary" onClick={() => { setShowAddProviderModal(false); setEditingAiProviderId(undefined); }} disabled={aiDraftSaving}>取消</button>
                  <button type="button" className="settingsBtnPrimary" onClick={() => void saveAiProviderFromDraft()} disabled={!aiDraftCanSave || aiDraftSaving}>
                    <Save size={14} />
                    {aiDraftSaving ? "保存中" : isAiQuickConnect ? "保存并使用" : editingAiProviderId ? "保存配置" : "保存接口"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (activeSettingsSection === "mcp") {
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection">
            <div className="settingsPaneHeader">
              <h3>MCP 服务器</h3>
              <p>连接外部工具和上下文源。MCP 工具会进入统一权限规则和审计记录。</p>
            </div>
            <div className="settingsRows">
              <div className="settingsRow mcpDraftRow">
                <span>
                  <strong>添加服务器</strong>
                  <small>填写 URL 创建 HTTP server，填写命令创建 stdio server。</small>
                </span>
                <input
                  aria-label="MCP 名称"
                  value={mcpDraft.name}
                  onChange={(event) => setMcpDraft((cur) => ({ ...cur, name: event.target.value }))}
                  placeholder="名称"
                />
                <input
                  aria-label="MCP 命令"
                  value={mcpDraft.command}
                  onChange={(event) => setMcpDraft((cur) => ({ ...cur, command: event.target.value }))}
                  placeholder="stdio 命令"
                />
                <input
                  aria-label="MCP URL"
                  value={mcpDraft.url}
                  onChange={(event) => setMcpDraft((cur) => ({ ...cur, url: event.target.value }))}
                  placeholder="https://..."
                />
                <button type="button" onClick={() => void addMcpServerFromDraft()}>添加</button>
              </div>
              {mcpServers.length === 0 && (
                <div className="settingsRow">
                  <span>
                    <strong>暂无 MCP 服务器</strong>
                    <small>添加后可以在这里启用、禁用或删除。</small>
                  </span>
                </div>
              )}
              {mcpServers.map((server) => (
                <div className={`settingsRow ${server.id === "github" ? "githubMcpRow" : ""}`} key={server.id}>
                  <span>
                    <strong>{server.name}</strong>
                    <small>
                      {server.transport === "http" ? server.url : server.command} · {server.enabled ? "已启用" : "已停用"} · 默认 {server.defaultApproval}
                      {server.bearerTokenEnvVar ? ` · 令牌变量 ${server.bearerTokenEnvVar}` : ""}
                    </small>
                    {server.id === "github" && <small>{githubMcpAuthorized ? "浏览器已授权；token 保存在系统安全存储" : "支持浏览器 OAuth 或环境变量 PAT；OAuth 将请求 repo、read:org"}</small>}
                    {server.id === "github" && <small className="githubMcpCallbackHint">OAuth App 回调 URL：<code>http://127.0.0.1/oauth/github/callback</code></small>}
                    {mcpStatus[server.id] && <small>{mcpStatus[server.id]}</small>}
                  </span>
                  {server.id === "github" && (
                    <div className="githubMcpAuthControls">
                      <input
                        aria-label="GitHub OAuth Client ID"
                        value={mcpOauthClientIds[server.id] ?? server.oauthClientId ?? ""}
                        onChange={(event) => setMcpOauthClientIds((current) => ({ ...current, [server.id]: event.target.value }))}
                        placeholder="GitHub OAuth Client ID"
                      />
                      <input
                        type="password"
                        aria-label="GitHub OAuth Client Secret"
                        value={githubOauthClientSecret}
                        onChange={(event) => setGithubOauthClientSecret(event.target.value)}
                        placeholder="Client Secret（不会保存）"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button type="button" onClick={() => void authorizeGithubMcp(server)}>浏览器授权</button>
                      {githubMcpAuthorized && <button type="button" onClick={() => void logoutGithubMcp(server)}>撤销授权</button>}
                    </div>
                  )}
                  <div className="mcpServerActions">
                    <button type="button" onClick={() => void saveMcpServer({ ...server, enabled: !server.enabled })}>
                      {server.enabled ? "停用" : "启用"}
                    </button>
                    <button type="button" disabled={!server.enabled} onClick={() => void testMcpServer(server.id)}>测试</button>
                    {server.id !== "github" && <button type="button" onClick={() => void deleteMcpServer(server.id)}>删除</button>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      );
    }

    if (activeSettingsSection === "usage") {
      const usage = usageSummary ?? {
        totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        prompts: { total: 0, sessionHits: 0, hitRate: 0 },
        aiCalls: 0,
        byModel: [],
        daily: [],
        recent: []
      };
      return (
        <div className="settingsContentStack">
          <section className="settingsPaneSection usageSection">
            <div className="settingsPaneHeader">
              <h3>使用情况和计费</h3>
              <p>按时间记录 token 活动、模型调用和缓存命中。</p>
            </div>
            {renderUsageActivityPanel(usage)}
            <div className="usageOverviewGrid">
              <div className="usageMetric">
                <span>总 Token</span>
                <strong>{formatUsageNumber(usage.totals.totalTokens)}</strong>
                <small>输入 {formatUsageNumber(usage.totals.promptTokens)} · 输出 {formatUsageNumber(usage.totals.completionTokens)}</small>
              </div>
              <div className="usageMetric">
                <span>AI 调用</span>
                <strong>{formatUsageNumber(usage.aiCalls)}</strong>
                <small>已记录模型请求次数</small>
              </div>
              <div className="usageMetric">
                <span>缓存 Token</span>
                <strong>{formatUsageNumber((usage.totals.cacheReadTokens ?? usage.totals.cachedTokens ?? 0) + (usage.totals.cacheCreationTokens ?? 0))}</strong>
                <small>读取 {formatUsageNumber(usage.totals.cacheReadTokens ?? usage.totals.cachedTokens ?? 0)} · 写入 {formatUsageNumber(usage.totals.cacheCreationTokens ?? 0)}</small>
              </div>
            </div>
            <div className="settingsRows usageModelRows">
              {usage.byModel.length === 0 ? (
                <div className="settingsRow">
                  <span>
                    <strong>暂无 token 记录</strong>
                    <small>完成一次模型调用后，这里会显示模型、调用次数和 token 用量。</small>
                  </span>
                </div>
              ) : usage.byModel.map((model) => (
                <div className="settingsRow" key={model.model}>
                  <span>
                    <strong>{model.model}</strong>
                    <small>
                      {formatUsageNumber(model.totalTokens)} token · {formatUsageNumber(model.calls)} 次调用 · 输入 {formatUsageNumber(model.promptTokens)} / 输出 {formatUsageNumber(model.completionTokens)}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="settingsContentStack">
        <section className="settingsPaneSection">
          <div className="settingsPaneHeader">
            <h3>{selectedSettingsItem.label}</h3>
            <p>暂无可配置项。</p>
          </div>
        </section>
      </div>
    );
  }

  function handleSidebarResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsSidebarResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const handlePointerUp = () => {
      setIsSidebarResizing(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  return (
    <main
      className="desktopShell"
      data-client={isDesktopClient ? "electron" : "web"}
      data-resizing={isSidebarResizing ? "sidebar" : undefined}
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      data-theme={resolvedTheme}
      style={shellStyle}
    >
      <section className="clientWindow">
        {isDesktopClient && (
          <AppTopBar
            isSettings={activeView === "settings"}
            title={activeView === "settings" ? selectedSettingsItem.label : activeSession?.title ?? "Rcode"}
            modelName={modelName}
            projectTokenTotal={activeView === "chat" ? activeProjectUsage : undefined}
            sidebarCollapsed={sidebarCollapsed}
            theme={resolvedTheme}
            onToggleSidebar={toggleSidebar}
            onToggleTheme={handleThemeToggle}
            onOpenSettings={() => openSettingsPage("general")}
          />
        )}
        <div className={`appLayout ${diffPanel ? "hasDiffPanel" : ""}`}>
          <aside
            className="sidebar projectSidebar"
            aria-hidden={sidebarCollapsed}
            inert={sidebarCollapsed ? true : undefined}
            aria-label="项目与会话"
          >
            <ProjectNavigator
              projects={workspaceState.projects}
              activeProjectId={activeProject?.id}
              activeSessionId={activeSession?.id}
              collapsedProjects={projectSessionCollapsed}
              swipeOffsets={sessionSwipeOffsets}
              runningSessionIds={runningSessionIds}
              archiveThreshold={sessionArchiveSwipeThreshold}
              onNewSession={() => addSession()}
              onNewProject={() => void createNewProject()}
              onOpenFolder={() => void addFolderProject()}
              onTemporarySession={startTemporarySession}
              onSelectProject={(projectId) => {
                const project = workspaceState.projects.find((item) => item.id === projectId);
                if (project) selectProject(project);
              }}
              onToggleProject={toggleProjectSessions}
              onSelectSession={selectSession}
              onArchiveSession={archiveSession}
              onResetSwipe={resetSessionSwipe}
              onSessionWheel={handleSessionWheel}
            />
            <button
              className={`sidebarProfileButton ${activeView === "settings" && activeSettingsSection === "profile" ? "active" : ""}`}
              type="button"
              onClick={() => openSettingsPage("profile")}
              aria-label={`打开 ${authUser.displayName} 的用户主页`}
            >
              <span className="accountAvatar sidebarProfileAvatar" aria-hidden="true">
                {authUser.displayName.slice(0, 2).toUpperCase()}
              </span>
              <span className="sidebarProfileIdentity">
                <strong>{authUser.displayName}</strong>
                <small>用户主页</small>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </aside>

          <div
            className="sidebarResizeHandle"
            onPointerDown={handleSidebarResizePointerDown}
            role="separator"
            aria-hidden={sidebarCollapsed}
            aria-label="调整项目栏宽度"
            aria-orientation="vertical"
            aria-valuemin={minSidebarWidth}
            aria-valuemax={maxSidebarWidth}
            aria-valuenow={sidebarWidth}
          />

          <section className="workspace">
            <section className="agentGrid">
              <div className="leftStack">
                {activeView === "settings" ? (
                  <section className="settingsPage" aria-label="设置">
                    <aside className="settingsSidebar">
                      {settingsGroups.map((group) => (
                        <section className="settingsNavGroup" key={group.title}>
                          <h2>{group.title}</h2>
                          <div className="settingsNavList">
                            {group.items.map((item) => (
                              <button
                                className={`settingsNavItem ${activeSettingsSection === item.id ? "active" : ""}`}
                                key={item.id}
                                type="button"
                                onClick={() => setSelectedSettingsSection(item.id)}
                              >
                                {renderSettingsIcon(item.id)}
                                <span>{item.label}</span>
                                {item.shortcut && <kbd>{item.shortcut}</kbd>}
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                      <div className="settingsNavFooter">
                        <div className="accountAvatar" aria-hidden="true">{authUser.displayName.slice(0, 2).toUpperCase()}</div>
                        <span>
                          <strong>{authUser.displayName}</strong>
                          <small>@{authUser.username}</small>
                        </span>
                        <button className="settingsSignOut" type="button" onClick={() => void logout()}>退出</button>
                      </div>
                    </aside>
                    <section className="settingsMainPane">
                      <div className="settingsMainHeader">
                        <button className="newChatButton" type="button" onClick={() => setActiveView("chat")}>
                          <MessageSquarePlus size={16} />
                          返回会话
                        </button>
                        <div>
                          <h2>{selectedSettingsItem.label}</h2>
                          <p>设置</p>
                        </div>
                      </div>
                      {renderSettingsContent()}
                    </section>
                  </section>
                ) : (
                <section className="chatPanel">
                  <div className="messageList" aria-live="polite" ref={messageListRef}>
                    {(() => {
                      const renderItems = getMessageRenderItems(visibleMessages);

                      const renderToolCallGroup = (
                        toolMessages: ChatMessage[],
                        options?: { groupId?: string; defaultOpen?: boolean }
                      ) => {
                        const runningCount = toolMessages.filter((message) =>
                          message.status === "running" || message.toolResult?.process?.status === "running"
                        ).length;
                        const failCount = toolMessages.filter((message) =>
                          message.status === "completed" && message.toolResult && (
                            !message.toolResult.ok ||
                            message.toolResult.process?.status === "failed" ||
                            (message.toolResult.process?.status === "exited" && (message.toolResult.process.exitCode ?? 0) !== 0)
                          )
                        ).length;
                        const hasRunning = runningCount > 0;
                        const groupSummary = getToolGroupSummary(toolMessages, activeProject?.path);
                        const activityGroups = getToolActivityGroups(toolMessages, activeProject?.path);
                        const activeToolSkills = [...new Set(toolMessages.flatMap((message) => message.activeSkills ?? []))]
                          .sort((a, b) => Number(a === "auto-learning") - Number(b === "auto-learning"))
                          .map((name) => ({
                            name,
                            label: skills.find((skill) => skill.name === name)?.displayName ?? name
                          }));
                        const groupId = options?.groupId ?? `group-${toolMessages[0].id}`;
                        const isManuallyClosed = manualClosedGroupsRef.current.has(groupId);
                        const isEditToolGroup = toolMessages.some((message) => isEditToolName(message.toolName));
                        const isCommandToolGroup = getToolActivityCategory(toolMessages[0]?.toolName) === "command";
                        // Live edit and command groups stay compact. Replays override
                        // this default so one click immediately reveals the timeline.
                        const isOpen = options?.defaultOpen ?? (
                          !isManuallyClosed && hasRunning && !isEditToolGroup && !isCommandToolGroup
                        );

                        return (
                          <ToolCallGroup
                            key={groupId}
                            groupId={groupId}
                            label={groupSummary.label}
                            detail={groupSummary.detail}
                            isRunning={groupSummary.isRunning}
                            isEditGroup={isEditToolGroup}
                            defaultOpen={isOpen}
                            failedCount={failCount}
                            addedLines={groupSummary.addedLines}
                            removedLines={groupSummary.removedLines}
                            isDiffEstimate={groupSummary.isDiffEstimate}
                            activeSkills={activeToolSkills}
                            activityGroups={activityGroups.map((activityGroup) => ({
                              category: activityGroup.category,
                              title: activityGroup.labels.title,
                              items: activityGroup.messages.map((message) => {
                                const lineChanges = getToolLineChangeStats(message);
                                return {
                                  id: message.id,
                                  name: message.toolName ?? "unknown_tool",
                                  target: getToolActivityTarget(message, activeProject?.path) || getToolDisplayTarget(message),
                                  status: message.status === "running" || message.toolResult?.process?.status === "running"
                                    ? "running"
                                    : message.toolResult?.ok === false || message.toolResult?.process?.status === "failed" || (message.toolResult?.process?.status === "exited" && (message.toolResult.process.exitCode ?? 0) !== 0)
                                      ? "fail"
                                      : "ok",
                                  args: message.toolArgs ? summarizeArguments(message.toolArgs) : undefined,
                                  result: message.toolResult?.process ? undefined : message.toolResult?.content.slice(0, 1500),
                                  process: message.toolResult?.process,
                                  ...lineChanges
                                };
                              })
                            }))}
                            onClosed={(id) => manualClosedGroupsRef.current.add(id)}
                            onStopProcess={stopManagedProcess}
                          />
                        );
                      };

                      const renderArtifactCard = (message: ChatMessage) => {
                        if (!message.artifactDiffs?.length) return null;
                        const artifactDiffs = [...new Map(
                          message.artifactDiffs.map((diff) => [normalizeFilePath(diff.filePath), diff])
                        ).values()];
                        const addedLines = artifactDiffs.reduce((sum, diff) => sum + diff.addedLines, 0);
                        const removedLines = artifactDiffs.reduce((sum, diff) => sum + diff.removedLines, 0);
                        const firstDiff = artifactDiffs[0];
                        const isExpanded = expandedArtifactCards.has(message.id);
                        const firstDisplayPath = getDisplayFilePath(firstDiff.filePath, activeProject?.path);
                        const remainingFileCount = artifactDiffs.length - 1;

                        const toggleFileList = () => {
                          setExpandedArtifactCards((current) => {
                            const next = new Set(current);
                            if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
                            return next;
                          });
                        };
                        const openArtifactReview = (diff: DiffResult) => {
                          setReviewDiffScope(artifactDiffs);
                          setDiffPanel(diff);
                        };

                        return (
                          <section className="codeEditCard deliverable finalArtifactCard" aria-label="本次编辑产物">
                            <div className="codeEditHeader">
                              <span className="codeEditIcon" aria-hidden="true">
                                <Pencil size={24} strokeWidth={2.1} />
                              </span>
                              <div className="codeEditTitleBlock">
                                <div className="codeEditTitleRow">
                                  <strong>已编辑 {artifactDiffs.length} 个文件</strong>
                                  <span className="codeEditTotalStats">
                                    {addedLines > 0 && <span className="diffAdded">+{addedLines}</span>}
                                    {removedLines > 0 && <span className="diffRemoved">-{removedLines}</span>}
                                  </span>
                                </div>
                                <p>变更已保存，可打开左右 diff 进行代码审查。</p>
                              </div>
                              <div className="codeEditActions">
                                <button
                                  className="codeEditAction secondary"
                                  type="button"
                                  onClick={toggleFileList}
                                  aria-expanded={isExpanded}
                                >
                                  {isExpanded ? "收起清单" : `文件 ${artifactDiffs.length}`}
                                </button>
                                <button className="codeEditAction review" type="button" onClick={() => openArtifactReview(firstDiff)}>
                                  审核
                                </button>
                              </div>
                            </div>
                            {!isExpanded && (
                              <button className="codeEditReviewHint" type="button" onClick={() => openArtifactReview(firstDiff)}>
                                <FileText size={16} aria-hidden="true" />
                                <span>
                                  <strong>{firstDisplayPath}</strong>
                                  {remainingFileCount > 0 && <small>以及另外 {remainingFileCount} 个文件</small>}
                                </span>
                                <ChevronRight size={17} aria-hidden="true" />
                              </button>
                            )}
                            {isExpanded && (
                              <div className="codeEditFileList">
                                {artifactDiffs.map((diff) => {
                                const displayPath = getDisplayFilePath(diff.filePath, activeProject?.path);
                                const fileName = getFileName(displayPath);
                                const dirName = displayPath === fileName ? "" : displayPath.slice(0, -fileName.length).replace(/\/$/, "");
                                return (
                                  <button className="codeEditFile" key={diff.filePath} type="button" onClick={() => openArtifactReview(diff)}>
                                    <span className="codeEditFilePath">
                                      {dirName && <span className="codeEditFileDir">{dirName}/</span>}
                                      <span className="codeEditFileName">{fileName}</span>
                                    </span>
                                    <span className="codeEditFileKind">{getDiffEditKind(diff)}</span>
                                    <span className="codeEditFileStats">
                                      {diff.addedLines > 0 && <span className="diffAdded">+{diff.addedLines}</span>}
                                      {diff.removedLines > 0 && <span className="diffRemoved">-{diff.removedLines}</span>}
                                      {diff.addedLines === 0 && diff.removedLines === 0 && <span className="diffNeutral">0</span>}
                                    </span>
                                  </button>
                                );
                                })}
                              </div>
                            )}
                          </section>
                        );
                      };

                      return renderItems.map((item) => {
                        if (item.type === "toolGroup") {
                          return renderToolCallGroup(item.messages);
                        }

                        const message = item.message;
                        const isAssistant = message.role === "assistant";
                        const isEmpty = !message.content?.trim();
                        const isActivelyStreaming = isActiveSessionRunning && Boolean(message.isStreaming);
                        const isResponseRunning = message.id === activeResponseMetaId;
                        const responseDurationMs = message.responseStartedAt
                          ? Math.max(
                              0,
                              (
                                message.responseCompletedAt ??
                                (isResponseRunning ? timerTick : message.completedAt ?? message.responseStartedAt)
                              ) - message.responseStartedAt
                            )
                          : message.durationMs ?? (
                              isActivelyStreaming && message.startedAt
                                ? Math.max(0, timerTick - message.startedAt)
                                : undefined
                            );
                        const showResponseMeta = isAssistant && message.showResponseMeta !== false && (
                          message.showResponseMeta === true || responseDurationMs !== undefined || Boolean(message.usage) || message.status !== undefined
                        );
                        const showTaskProgress = isAssistant && message.id === activeResponseMetaId && shouldShowTaskDuration;
                        const showFinalBadge = message.status === "completed" && !isActivelyStreaming;
                        const hasProviderUsage = message.usage?.billedTotalTokens !== undefined;
                        const displayPromptTokens = hasProviderUsage
                          ? message.usage?.billedPromptTokens ?? 0
                          : message.status === "error"
                            ? 0
                            : message.usage?.promptTokens ?? 0;
                        const displayCompletionTokens = hasProviderUsage
                          ? message.usage?.billedCompletionTokens ?? 0
                          : message.status === "error"
                            ? 0
                            : message.usage?.completionTokens ?? 0;
                        const inputUsageTitle = hasProviderUsage
                          ? "上游返回的真实输入 token（包含本次请求上下文）"
                          : message.status === "error"
                            ? "请求失败且上游未返回 usage，不计 token"
                            : "生成期间的本条消息 token 估算，完成后由上游 usage 校准";
                        const outputUsageTitle = hasProviderUsage
                          ? "上游返回的真实输出 token"
                          : message.status === "error"
                            ? "请求失败且上游未返回 usage，不计 token"
                            : "生成期间的可见回复 token 估算，完成后由上游 usage 校准";
                        const replayMessages = showFinalBadge ? getResponseReplayMessages(messages, message.id) : [];
                        const isReplayOpen = expandedResponseReplays.has(message.id);
                        const replayPanelId = `response-replay-${message.id}`;

                        const toggleReplay = () => {
                          setExpandedResponseReplays((current) => {
                            const next = new Set(current);
                            if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
                            return next;
                          });
                        };

                        return (
                          <Fragment key={message.id}>
                          <article className={`message ${message.role} ${isEmpty && isActivelyStreaming ? "streamingOnly" : ""}`}>
                            {showTaskProgress && (
                              <div className="taskDurationBar running" aria-label="本次回复进度">
                                <span className="taskDurationText">
                                  {activeSession?.workflowLabel ?? "正在思考"}
                                </span>
                                <span className="taskDurationElapsed">{formatTaskDuration(activeTaskElapsedMs)}</span>
                                <span className="taskThinkingState" aria-label={activeWorkflowActivityLabel}>
                                  <span>{activeWorkflowActivityLabel}</span>
                                  <span className="thinkingWave" aria-hidden="true">
                                    <i />
                                    <i />
                                    <i />
                                    <i />
                                  </span>
                                </span>
                                {activeSession?.contextSnapshot && (
                                  <span className="contextBudgetBadge" title={`上下文预算 ${activeSession.contextSnapshot.budgetTokens.toLocaleString()} tokens`}>
                                    上下文 {Math.round(activeSession.contextSnapshot.estimatedTokens / 100) / 10}k
                                    {activeSession.contextSnapshot.compactedMessageCount > 0 ? ` · 已压缩 ${activeSession.contextSnapshot.compactedMessageCount}` : ""}
                                  </span>
                                )}
                                <ChevronDown size={17} strokeWidth={2.1} />
                              </div>
                            )}
                            {showResponseMeta && (
                              <div className="messageMeta" aria-label="本次回复统计">
                                <span className="responseModel">{message.usage?.model ?? modelName}</span>
                                {responseDurationMs !== undefined && (
                                  <span className="responseMetric">耗时 {formatResponseDuration(responseDurationMs)}</span>
                                )}
                                <span className="responseMetric" title={inputUsageTitle}>
                                  上传 {formatUsageNumber(displayPromptTokens)} token
                                </span>
                                <span className="responseMetric" title={outputUsageTitle}>
                                  下传 {formatUsageNumber(displayCompletionTokens)} token
                                </span>
                                {isResponseRunning && <strong className="streaming">生成中</strong>}
                                {message.status === "error" && <strong className="toolFail">error</strong>}
                                {message.status === "approval_required" && <strong>approval_required</strong>}
                                {showFinalBadge && (
                                  <button
                                    className={`responseReplayButton ${isReplayOpen ? "active" : ""}`}
                                    type="button"
                                    aria-expanded={isReplayOpen}
                                    aria-controls={replayPanelId}
                                    onClick={toggleReplay}
                                    title={replayMessages.length > 0 ? `查看本轮 ${replayMessages.length} 次工具调用` : "本轮没有工具调用"}
                                  >
                                    <History size={11} aria-hidden="true" />
                                    {isReplayOpen ? "收起回放" : "查看回放"}
                                    <ChevronDown size={11} aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            )}
                            {showFinalBadge && isReplayOpen && (
                              <section className="responseReplayPanel" id={replayPanelId} aria-label="本轮工具调用回放">
                                <div className="responseReplayHeader">
                                  <span><History size={14} aria-hidden="true" />执行回放</span>
                                  <small>{replayMessages.length > 0 ? `${replayMessages.length} 次工具调用` : "没有工具调用"}</small>
                                </div>
                                {replayMessages.length > 0
                                  ? renderToolCallGroup(replayMessages, { groupId: `replay-group-${message.id}`, defaultOpen: true })
                                  : <p className="responseReplayEmpty">本轮直接生成回复，未调用任何工具。</p>}
                              </section>
                            )}
                            {message.role === "user" && Boolean(message.attachments?.length) && (
                              <div className="messageAttachmentGrid" aria-label="消息附件">
                                {message.attachments!.map((attachment) => (
                                  <div className={`messageAttachment ${attachment.kind}`} key={attachment.id} title={attachment.name}>
                                    {attachment.kind === "image" && attachment.dataUrl ? (
                                      <img src={attachment.dataUrl} alt={attachment.name} />
                                    ) : (
                                      <span className="messageAttachmentFileIcon"><FileText size={18} /></span>
                                    )}
                                    <span>
                                      <strong>{attachment.name}</strong>
                                      <small>{attachment.mimeType}</small>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {!isEmpty && (
                              <div className={`messageBubble ${isAssistant ? "assistantBubble" : ""}`}>
                                {renderMessageContent(isAssistant ? message.content.trimEnd() : message.content, activeProject?.path)}
                                {isActivelyStreaming && <span className="streamingCursor">▊</span>}
                              </div>
                            )}
                          </article>
                          {renderArtifactCard(message)}
                          </Fragment>
                        );
                      });
                    })()}

                    {pendingApprovals.length > 0 && (
                      <div className="approvalStack inlineApproval">
                        {pendingApprovals.slice(0, 1).map((approval) => (
                          <article className="approvalCard" key={approval.id}>
                            <div>
                              <strong>{approval.reason}</strong>
                              <span>风险级别：{approval.risk}</span>
                            </div>
                            <pre>{summarizeArguments(approval.toolCall.arguments)}</pre>
                            <div className="approvalActions">
                              <button type="button" onClick={() => decideApproval(approval.id, false)}>
                                <X size={16} />
                                拒绝
                              </button>
                              <button type="button" onClick={() => decideApproval(approval.id, true)}>
                                <Check size={16} />
                                允许
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}

	                  </div>

                      {activeSession?.taskPlan && activeSession.workflowPhase === "plan_ready" && (
                        <TaskPlanCard plan={activeSession.taskPlan} disabled={isActiveSessionRunning} onStart={startPlannedExecution} />
                      )}

	                  {activeQueuedPrompts.length > 0 && activeSession && (
	                    <div className="queuePanel" aria-label="排队中的后续请求">
	                      {activeQueuedPrompts.map((item, index) => (
	                        <div className={`queueItem ${item.kind === "guide" ? "guide" : ""}`} key={item.id}>
	                          <CornerDownRight size={15} />
	                          <span className="queueItemText">
	                            {item.kind === "guide" && <strong>引导</strong>}
	                            {item.content || item.attachments?.map((attachment) => attachment.name).join("、") || "附件消息"}
	                          </span>
	                          <span className="queueItemMeta">{item.attachments?.length ? `${item.attachments.length} 个附件 · ` : ""}{index === 0 ? "下一个" : `#${index + 1}`}</span>
	                          <button
	                            className="queueItemAction"
	                            type="button"
	                            onClick={() => guideQueuedPrompt(activeSession.id, item.id)}
	                            disabled={item.kind === "guide"}
	                          >
	                            <CornerDownRight size={14} />
	                            引导
	                          </button>
	                          <button
	                            className="queueIconAction"
	                            type="button"
	                            aria-label="删除排队请求"
	                            onClick={() => removeQueuedPrompt(activeSession.id, item.id)}
	                          >
	                            <Trash2 size={14} />
	                          </button>
	                          <button className="queueIconAction" type="button" aria-label="更多">
	                            <MoreHorizontal size={15} />
	                          </button>
	                        </div>
	                      ))}
	                    </div>
	                  )}

                  <ChatComposer
                    prompt={prompt}
                    attachments={composerAttachments}
                    modelName={modelName}
                    modelOptions={modelOptions}
                    modelMenuOpen={modelMenuOpen}
                    thinkingMode={thinkingMode}
                    permissionMode={currentMode}
                    permissionOptions={permissionOptions}
                    selectedPermission={selectedPermission}
                    permissionMenuOpen={permissionMenuOpen}
                    queueLength={activeQueueLength}
                    isRunning={isActiveSessionRunning}
                    projectName={activeProject?.name}
                    projectPath={activeProject?.path}
                    managedProcesses={currentProjectManagedProcesses}
                    managedProcessPanelOpen={managedProcessPanelOpen}
                    managedProcessLoadError={managedProcessLoadError}
                    onPromptChange={setPrompt}
                    onAttachmentsChange={(attachments) => {
                      if (!activeSession) return;
                      setComposerAttachmentsBySession((current) => ({ ...current, [activeSession.id]: attachments }));
                    }}
                    onKeyDown={handleComposerKeyDown}
                    onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
                    onSelectModel={(model) => {
                      setSelectedModel(model);
                      setModelMenuOpen(false);
                    }}
                    onThinkingModeChange={setThinkingMode}
                    onTogglePermissionMenu={() => setPermissionMenuOpen((open) => !open)}
                    onSelectPermission={(nextMode) => {
                      if (nextMode === "full_access" && !window.confirm("完全访问会移除工作区沙箱限制。确定要启用吗？")) return;
                      changeSessionMode(nextMode);
                      setPermissionMenuOpen(false);
                    }}
                    onSend={handleSendButtonClick}
                    onToggleManagedProcessPanel={() => {
                      const nextOpen = !managedProcessPanelOpen;
                      setManagedProcessPanelOpen(nextOpen);
                      if (nextOpen) void refreshManagedProcesses().catch(() => undefined);
                    }}
                    onRefreshManagedProcesses={refreshManagedProcesses}
                    onStopManagedProcess={stopManagedProcess}
                  />
                </section>
                )}
              </div>
            </section>
          </section>
        </div>
        {/* 右侧 diff 对比面板 */}
        {diffPanel && (
          <aside className="diffPanel" aria-label="代码审核">
            <div className="diffPanelHeader">
              <div className="diffPanelTitle">
                <span className="diffPanelMode">
                  <FileText size={16} />
                  代码审核
                </span>
                <span className="diffPanelSummary">{reviewDiffs.length} 个文件</span>
                <div className="diffPanelStats">
                  <span className="diffAdded">+{reviewTotals.added}</span>
                  <span className="diffRemoved">-{reviewTotals.removed}</span>
                </div>
              </div>
              <div className="diffPanelActions">
                <button
                  className={`diffPanelAction ${diffChangesOnly ? "active" : ""}`}
                  type="button"
                  aria-pressed={diffChangesOnly}
                  onClick={() => setDiffChangesOnly((current) => !current)}
                >
                  {diffChangesOnly ? "仅显示变更" : "显示上下文"}
                </button>
                <div className="diffViewSwitch" role="group" aria-label="差异视图">
                  <button
                    className={diffView === "split" ? "active" : ""}
                    type="button"
                    aria-pressed={diffView === "split"}
                    onClick={() => setDiffView("split")}
                  >
                    左右
                  </button>
                  <button
                    className={diffView === "unified" ? "active" : ""}
                    type="button"
                    aria-pressed={diffView === "unified"}
                    onClick={() => setDiffView("unified")}
                  >
                    统一
                  </button>
                </div>
                <div className="diffPanelNavigator" aria-label="切换审核文件">
                  <button
                    type="button"
                    onClick={() => selectAdjacentReviewFile(-1)}
                    disabled={reviewDiffs.length < 2}
                    aria-label="上一个变更文件"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span>{activeReviewIndex + 1}/{reviewDiffs.length}</span>
                  <button
                    type="button"
                    onClick={() => selectAdjacentReviewFile(1)}
                    disabled={reviewDiffs.length < 2}
                    aria-label="下一个变更文件"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <button
                  className="diffPanelClose"
                  type="button"
                  onClick={() => {
                    setDiffPanel(null);
                    setReviewDiffScope(null);
                  }}
                  aria-label="关闭审核"
                  title="关闭审核"
                >
                  <X size={17} />
                </button>
              </div>
            </div>
            <div className="diffPanelBody">
              <main className="diffPanelReview">
                <div className="diffFileHeader">
                  <div className="diffPanelFileInfo">
                    <div className="diffPanelFileHeading">
                      <span className="diffPanelFileName">{getFileName(diffPanel.filePath)}</span>
                      <button
                        className={`diffCopyPath ${diffPathCopied ? "copied" : ""}`}
                        type="button"
                        onClick={() => void copyReviewFilePath()}
                        title="复制文件路径"
                      >
                        <Copy size={14} />
                        <span>{diffPathCopied ? "已复制" : "复制路径"}</span>
                      </button>
                    </div>
                    <span className="diffPanelPath">{getDisplayFilePath(diffPanel.filePath, activeProject?.path)}</span>
                  </div>
                  <div className="diffPanelStats fileStats">
                    <span className="diffAdded">+{diffPanel.addedLines}</span>
                    <span className="diffRemoved">-{diffPanel.removedLines}</span>
                  </div>
                </div>
                <div className="diffPanelContent">
                  {diffView === "split" ? (
                    <>
                      <div className="diffCompareHeaders" aria-hidden="true">
                        <span>原始版本</span>
                        <span>修改后</span>
                      </div>
                      <table className="splitDiffTable">
                        <tbody>
                          {splitDiffReviewRows.map((row) => {
                            if (row.kind === "fold") {
                              return (
                                <tr key={`fold-${row.key}`} className="diffSplitFold">
                                  <td colSpan={6}>
                                    <ChevronDown size={15} />
                                    {row.hiddenCount} 行未修改
                                  </td>
                                </tr>
                              );
                            }
                            const { oldLine, newLine } = row;
                            return (
                              <tr className="diffSplitRow" key={row.key}>
                                <td className={`diffSplitLineNum old ${oldLine?.type ?? "empty"}`}>{oldLine?.oldLine ?? ""}</td>
                                <td className={`diffSplitMarker old ${oldLine?.type ?? "empty"}`}>{oldLine?.type === "remove" ? "−" : ""}</td>
                                <td className={`diffSplitContent old ${oldLine?.type ?? "empty"}`}><pre>{oldLine?.content || " "}</pre></td>
                                <td className={`diffSplitLineNum new ${newLine?.type ?? "empty"}`}>{newLine?.newLine ?? ""}</td>
                                <td className={`diffSplitMarker new ${newLine?.type ?? "empty"}`}>{newLine?.type === "add" ? "+" : ""}</td>
                                <td className={`diffSplitContent new ${newLine?.type ?? "empty"}`}><pre>{newLine?.content || " "}</pre></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  ) : (
                    <table className="diffTable">
                      <tbody>
                        {visibleDiffReviewRows.map((row) => {
                          if (row.kind === "fold") {
                            return (
                              <tr key={`fold-${row.key}`} className="diffFoldRow">
                                <td className="diffFoldToggle" colSpan={3}>
                                  <ChevronDown size={16} />
                                </td>
                                <td className="diffFoldContent">{row.hiddenCount} 行未修改</td>
                              </tr>
                            );
                          }
                          const line = row.line;
                          return (
                            <tr key={`line-${row.index}`} className={`diffLine ${line.type}`}>
                              <td className="diffLineNum old">{line.oldLine ?? ""}</td>
                              <td className="diffLineNum new">{line.newLine ?? ""}</td>
                              <td className="diffLineSign">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</td>
                              <td className="diffLineContent"><pre>{line.content || " "}</pre></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </main>
              <aside className="diffFileSidebar" aria-label="变更文件">
                <div className="diffSidebarHeader">
                  <div>
                    <span>变更文件</span>
                    <strong>{filteredReviewDiffs.length}<small> / {reviewDiffs.length}</small></strong>
                  </div>
                  <span className="diffSidebarHint">按路径筛选</span>
                </div>
                <label className="diffFileSearch">
                  <Search size={15} />
                  <input
                    aria-label="筛选变更文件"
                    value={diffSearch}
                    onChange={(event) => setDiffSearch(event.target.value)}
                    placeholder="筛选文件..."
                  />
                  {diffSearch && (
                    <button type="button" onClick={() => setDiffSearch("")} aria-label="清除筛选">
                      <X size={14} />
                    </button>
                  )}
                </label>
                <div className="diffFileTreeLabel">
                  <ChevronDown size={16} />
                  <span>{activeProject?.path ? getFileName(activeProject.path) : "files"}</span>
                </div>
                <div className="diffFileTree">
                  {filteredReviewDiffs.length === 0 && (
                    <div className="diffFileEmpty">未找到匹配的变更文件</div>
                  )}
                  {filteredReviewDiffs.map((diff) => {
                    const isActive = normalizeFilePath(diff.filePath) === normalizeFilePath(diffPanel.filePath);
                    return (
                      <button
                        className={`diffFileTreeItem ${isActive ? "active" : ""}`}
                        key={diff.filePath}
                        type="button"
                        onClick={() => setDiffPanel(diff)}
                        title={diff.filePath}
                      >
                      <FileText size={16} />
                        <span className="diffFileTreeCopy">
                          <span className="diffFileTreeName">{getFileName(diff.filePath)}</span>
                          <small>{getDisplayFilePath(diff.filePath, activeProject?.path)}</small>
                        </span>
                        <span className="diffFileTreeStats">
                          {diff.addedLines > 0 && <span className="diffAdded">+{diff.addedLines}</span>}
                          {diff.removedLines > 0 && <span className="diffRemoved">-{diff.removedLines}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </aside>
            </div>
          </aside>
        )}
      </section>
    </main>
  );
}
