/**
 * Local workspace + thread persistence for the Rcode provider.
 *
 * DeepSeek-GUI's renderer expects a "thread" to carry a workspace path and a
 * list of chat blocks. Rcode's own backend only persists agent conversations
 * keyed by conversationId; the project/session tree historically lived in the
 * renderer's localStorage. This module keeps that arrangement: thread metadata
 * and message history are stored locally, while the server-side conversationId
 * is kept so the agent runtime can continue long conversations.
 */

export interface RcodeProject {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface RcodeMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  toolOk?: boolean;
  toolSummary?: string;
  diffFilePath?: string;
  status?: "completed" | "running" | "error" | "approval_required";
}

export interface RcodeThread {
  id: string;
  projectPath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  mode: string;
  model: string;
  conversationId?: string;
  messages: RcodeMessage[];
  lastSeq: number;
}

interface WorkspaceData {
  projects: RcodeProject[];
  threads: RcodeThread[];
}

const STORAGE_KEY = "rcode.dsgui.workspace.v1";

function now(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function load(): WorkspaceData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { projects: [], threads: [] };
    const parsed = JSON.parse(raw) as Partial<WorkspaceData>;
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      threads: Array.isArray(parsed.threads) ? parsed.threads : []
    };
  } catch {
    return { projects: [], threads: [] };
  }
}

function save(data: WorkspaceData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage quota exceeded — drop oldest archived threads and retry once.
    const trimmed: WorkspaceData = {
      projects: data.projects,
      threads: data.threads.filter((t) => !t.archived).slice(-50)
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* give up silently; the app keeps working in-memory */
    }
  }
}

/* ------------------------------ projects ------------------------------ */

export function listProjects(): RcodeProject[] {
  return load().projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProjectByPath(path: string): RcodeProject | undefined {
  return load().projects.find((p) => p.path === path);
}

export function addProject(name: string, path: string): RcodeProject {
  const data = load();
  const existing = data.projects.find((p) => p.path === path);
  if (existing) return existing;
  const project: RcodeProject = { id: createId("project"), name, path, createdAt: now() };
  data.projects.push(project);
  save(data);
  return project;
}

export function renameProject(path: string, name: string): void {
  const data = load();
  const project = data.projects.find((p) => p.path === path);
  if (!project) return;
  project.name = name;
  save(data);
}

/* ------------------------------- threads ------------------------------ */

export function listThreads(options?: { includeArchived?: boolean }): RcodeThread[] {
  const threads = load().threads;
  return threads
    .filter((t) => (options?.includeArchived ? true : !t.archived))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getThread(threadId: string): RcodeThread | undefined {
  return load().threads.find((t) => t.id === threadId);
}

export function createThread(input: { projectPath: string; title?: string; mode?: string; model?: string }): RcodeThread {
  const data = load();
  const thread: RcodeThread = {
    id: createId("thread"),
    projectPath: input.projectPath,
    title: input.title?.trim() || "New Thread",
    createdAt: now(),
    updatedAt: now(),
    archived: false,
    mode: input.mode ?? "agent",
    model: input.model ?? "",
    messages: [],
    lastSeq: 0
  };
  data.threads.push(thread);
  save(data);
  return thread;
}

export function updateThread(threadId: string, patch: Partial<Omit<RcodeThread, "id">>): RcodeThread | undefined {
  const data = load();
  const thread = data.threads.find((t) => t.id === threadId);
  if (!thread) return undefined;
  Object.assign(thread, patch, { updatedAt: now() });
  save(data);
  return thread;
}

export function deleteThread(threadId: string): void {
  const data = load();
  data.threads = data.threads.filter((t) => t.id !== threadId);
  save(data);
}

/* ------------------------------- messages ----------------------------- */

export function appendMessage(threadId: string, message: RcodeMessage): void {
  const data = load();
  const thread = data.threads.find((t) => t.id === threadId);
  if (!thread) return;
  thread.messages.push(message);
  thread.updatedAt = now();
  save(data);
}

export function updateMessage(threadId: string, messageId: string, patch: Partial<RcodeMessage>): void {
  const data = load();
  const thread = data.threads.find((t) => t.id === threadId);
  if (!thread) return;
  const message = thread.messages.find((m) => m.id === messageId);
  if (!message) return;
  Object.assign(message, patch);
  thread.updatedAt = now();
  save(data);
}

export function setThreadMessages(threadId: string, messages: RcodeMessage[]): void {
  const data = load();
  const thread = data.threads.find((t) => t.id === threadId);
  if (!thread) return;
  thread.messages = messages;
  thread.updatedAt = now();
  save(data);
}

export function bumpThreadSeq(threadId: string): number {
  const data = load();
  const thread = data.threads.find((t) => t.id === threadId);
  if (!thread) return 0;
  thread.lastSeq += 1;
  save(data);
  return thread.lastSeq;
}
