import {
  Archive,
  Brain,
  Check,
  ChevronDown,
  CornerDownRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  ListFilter,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  SquareChevronLeft,
  SquareChevronRight,
  Send,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { KeyboardEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";

type PermissionMode = "request_approval" | "auto_approve" | "full_access";
type ThemePreference = "system" | "dark" | "light";
type ThinkingMode = "fast" | "balanced" | "deep";
type ProjectKind = "empty" | "folder";
type MessageStatus = "completed" | "approval_required" | "error" | "running";

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
  status?: MessageStatus;
  isStreaming?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: { ok: boolean; content: string };
  diff?: DiffResult;
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

interface QueuedPrompt {
  id: string;
  content: string;
  kind?: "prompt" | "guide";
}

/** SSE 流事件 */
interface StreamEvent {
  type: "text_delta" | "tool_call" | "tool_result" | "approval_required" | "completed" | "error";
  content?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId: string; name: string; ok: boolean; content: string; diff?: DiffResult };
  conversationId?: string;
  answer?: string;
  message?: string;
  approvals?: PendingApproval[];
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

const workspaceStorageKey = "agent.workspace.projects.v1";
const API_BASE = window.location.protocol === "file:" || window.agentDesktop?.isDesktopClient ? "http://localhost:8787" : "";
const thinkingOptions: Array<{ id: ThinkingMode; label: string }> = [
  { id: "fast", label: "快速" },
  { id: "balanced", label: "标准" },
  { id: "deep", label: "深度" }
];

const defaultPermissionOptions: PermissionOption[] = [
  { id: "request_approval", label: "请求批准", description: "项目内文件操作直接执行，项目外操作请求审批" },
  { id: "auto_approve", label: "替我审批", description: "由当前模型自动审核工具风险并决定是否执行" },
  { id: "full_access", label: "完全访问", description: "允许所有工具操作直接执行" }
];

const toolActionLabels: Record<string, { running: string; completed: string; noun: string }> = {
  read_file: { running: "正在读取", completed: "已读取", noun: "个文件" },
  write_file: { running: "正在编辑", completed: "已编辑", noun: "个文件" },
  run_shell: { running: "正在运行", completed: "已运行", noun: "条命令" },
  web_fetch: { running: "正在获取", completed: "已获取", noun: "个网页" }
};

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function createWelcomeMessage(): ChatMessage {
  return {
    id: createId("message"),
    role: "assistant",
    content: "你好，我是本地 Agent。你可以像聊天一样输入任务，按 Enter 发送；需要换行时按 Shift + Enter。"
  };
}

function createSession(title = "新会话"): ProjectSession {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [createWelcomeMessage()],
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

function getDefaultWorkspace(): WorkspaceState {
  const project = createProject("Agent Console", "empty");
  return {
    projects: [project],
    activeProjectId: project.id,
    activeSessionId: project.sessions[0].id
  };
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as WorkspaceState;
  return Array.isArray(state.projects) && typeof state.activeProjectId === "string" && typeof state.activeSessionId === "string";
}

function loadWorkspaceState(): WorkspaceState {
  try {
    const parsed = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null");
    if (isWorkspaceState(parsed) && parsed.projects.length > 0) return parsed;
  } catch { /* ignore */ }
  return getDefaultWorkspace();
}

function summarizeArguments(args: Record<string, unknown>) {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 90)}`)
    .join("\n");
}

function renderMessageContent(content: string) {
  return content.split(/(`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code className="inlineCode" key={`${part}-${index}`}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
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

function getToolDisplayTarget(message: ChatMessage) {
  const pathArg = message.toolArgs?.path as string | undefined;
  const commandArg = message.toolArgs?.command as string | undefined;
  const urlArg = message.toolArgs?.url as string | undefined;
  if (pathArg) return getFileName(pathArg);
  const target = commandArg ?? urlArg ?? "";
  if (!target) return "";
  return target.length > 42 ? `...${target.slice(-39)}` : target;
}

function getToolGroupSummary(toolMessages: ChatMessage[]) {
  const runningCount = toolMessages.filter((m) => m.status === "running").length;
  const doneCount = toolMessages.filter((m) => m.status === "completed").length;
  const hasRunning = runningCount > 0;
  const allDone = doneCount === toolMessages.length;
  const toolNames = [...new Set(toolMessages.map((m) => m.toolName).filter(Boolean))] as string[];
  const primaryTool = toolNames.length === 1 ? toolNames[0] : undefined;
  const labels = primaryTool ? toolActionLabels[primaryTool] : undefined;
  const diffMessages = toolMessages.filter((message) => message.diff);
  const addedLines = diffMessages.reduce((sum, message) => sum + (message.diff?.addedLines ?? 0), 0);
  const removedLines = diffMessages.reduce((sum, message) => sum + (message.diff?.removedLines ?? 0), 0);
  const focusedMessage =
    toolMessages.find((m) => m.status === "running") ??
    diffMessages[0] ??
    toolMessages.find((m) => m.toolArgs?.path || m.toolArgs?.command || m.toolArgs?.url) ??
    toolMessages[0];
  const target = focusedMessage ? getToolDisplayTarget(focusedMessage) : "";

  if (hasRunning) {
    return {
      label: labels ? `${labels.running} ${runningCount} ${labels.noun}` : `正在调用工具 ${toolNames.join(", ")}...`,
      detail: target ? `${labels?.running ?? "正在处理"} ${target}` : undefined,
      addedLines,
      removedLines,
      isRunning: true,
      primaryTool
    };
  }

  if (allDone) {
    return {
      label: labels ? `${labels.completed} ${toolMessages.length} ${labels.noun}` : `已完成 ${toolMessages.length} 次工具调用`,
      detail: target ? `${labels?.completed ?? "已处理"} ${target}` : undefined,
      addedLines,
      removedLines,
      isRunning: false,
      primaryTool
    };
  }

  return {
    label: `工具调用 ${toolNames.join(", ")} (${doneCount}/${toolMessages.length})`,
    detail: target ? `正在处理 ${target}` : undefined,
    addedLines,
    removedLines,
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
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(() => loadWorkspaceState());
  const [mode, setMode] = useState<PermissionMode>("request_approval");
  const [prompt, setPrompt] = useState("");
  const [themePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem("agent.themePreference");
    return saved === "dark" || saved === "light" || saved === "system" ? saved : "system";
  });
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<{ providerConfigured: boolean; model: string; provider?: string }>();
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("balanced");
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [permissionOptions, setPermissionOptions] = useState<PermissionOption[]>(defaultPermissionOptions);
  const isDesktopClient = Boolean(window.agentDesktop?.isDesktopClient);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const workspaceStateRef = useRef(workspaceState);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const queuedPromptsRef = useRef<Map<string, QueuedPrompt[]>>(new Map());
  const swipeStartRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [queueVersion, setQueueVersion] = useState(0);
  const [swipedSessionId, setSwipedSessionId] = useState<string | undefined>();
  // 追踪用户手动关闭的工具折叠组，避免重渲染时自动展开
  const manualClosedGroupsRef = useRef<Set<string>>(new Set());
  // diff 对比面板
  const [diffPanel, setDiffPanel] = useState<DiffResult | null>(null);

  function markSessionRunning(sessionId: string) {
    setRunningSessionIds((cur) => new Set(cur).add(sessionId));
  }
  function markSessionIdle(sessionId: string) {
    setRunningSessionIds((cur) => {
      const next = new Set(cur);
      next.delete(sessionId);
      return next;
    });
  }

  const resolvedTheme = themePreference === "system" ? systemTheme : themePreference;
  const modelName = selectedModel || health?.model || "Agent";
  const selectedPermission =
    permissionOptions.find((item) => item.id === mode) ??
    defaultPermissionOptions.find((item) => item.id === mode) ??
    defaultPermissionOptions[0];

  const activeProject = useMemo(
    () => workspaceState.projects.find((project) => project.id === workspaceState.activeProjectId),
    [workspaceState]
  );
  const activeSession = useMemo(
    () => activeProject?.sessions.find((session) => session.id === workspaceState.activeSessionId),
    [activeProject, workspaceState.activeSessionId]
  );

  const messages = activeSession?.messages ?? [];
  const pendingApprovals = activeSession?.pendingApprovals ?? [];
  const conversationId = activeSession?.conversationId;
  const isActiveSessionRunning = activeSession ? runningSessionIds.has(activeSession.id) : false;
  const hasVisibleProcess =
    isActiveSessionRunning ||
    pendingApprovals.length > 0 ||
    messages.some((message) => message.isStreaming || message.status === "approval_required" || message.status === "running");
  const completedViewMessageIds = useMemo(
    () => (hasVisibleProcess ? undefined : getCompletedViewMessageIds(messages)),
    [hasVisibleProcess, messages]
  );
  const visibleMessages = useMemo(
    () =>
      completedViewMessageIds
        ? messages.filter((message) => message.role !== "tool" && completedViewMessageIds.has(message.id))
        : messages,
    [completedViewMessageIds, messages]
  );
  const activeQueuedPrompts = useMemo(
    () => (activeSession ? (queuedPromptsRef.current.get(activeSession.id) ?? []) : []),
    [activeSession, queueVersion]
  );
  const activeQueueLength = useMemo(
    () => activeQueuedPrompts.length,
    [activeQueuedPrompts]
  );

  useEffect(() => {
    workspaceStateRef.current = workspaceState;
    localStorage.setItem(workspaceStorageKey, JSON.stringify(workspaceState));
  }, [workspaceState]);

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
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [workspaceState.activeSessionId, messages.length, pendingApprovals.length, isActiveSessionRunning]);

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
    setSwipedSessionId(undefined);
    setWorkspaceState((cur) => ({ ...cur, activeProjectId: projectId, activeSessionId: sessionId }));
  }

  function addProject(project: AgentProject) {
    setWorkspaceState((cur) => ({
      projects: [project, ...cur.projects],
      activeProjectId: project.id,
      activeSessionId: project.sessions[0].id
    }));
  }

  function addEmptyProject() {
    const name = window.prompt("空项目名称", "空项目");
    if (!name?.trim()) return;
    addProject(createProject(name.trim(), "empty"));
  }

  async function addFolderProject() {
    const folderPath = await window.agentDesktop?.selectProjectFolder?.();
    if (!folderPath) return;
    addProject(createProject(getFolderName(folderPath), "folder", folderPath));
  }

  async function createFolderProject() {
    const name = window.prompt("新建文件夹项目名称", "新项目");
    if (!name?.trim()) return;
    const folderPath = await window.agentDesktop?.createFolderProject?.(name.trim());
    addProject(createProject(name.trim(), folderPath ? "folder" : "empty", folderPath));
  }

  function addSession(projectId = workspaceState.activeProjectId) {
    const session = createSession();
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
    setSwipedSessionId(undefined);
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

  function handleSessionPointerDown(sessionId: string, event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    swipeStartRef.current.set(sessionId, { x: event.clientX, y: event.clientY });
  }

  function releaseSessionPointer(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleSessionPointerMove(sessionId: string, event: PointerEvent<HTMLButtonElement>) {
    const start = swipeStartRef.current.get(sessionId);
    if (!start) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (deltaX < -28 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
      setSwipedSessionId(sessionId);
    }
  }

  function handleSessionPointerUp(projectId: string, sessionId: string, event: PointerEvent<HTMLButtonElement>) {
    const start = swipeStartRef.current.get(sessionId);
    swipeStartRef.current.delete(sessionId);
    releaseSessionPointer(event);
    if (!start) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (deltaX < -86 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
      archiveSession(projectId, sessionId);
    }
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

  function enqueuePrompt(sessionId: string, content: string) {
    const q = queuedPromptsRef.current.get(sessionId) ?? [];
    queuedPromptsRef.current.set(sessionId, [...q, { id: createId("queue"), content, kind: "prompt" }]);
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

  function appendUserMessage(projectId: string, sessionId: string, content: string) {
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: createId("message"), role: "user", content };
    updateSession(projectId, sessionId, (s) => ({
      ...s,
      title: s.title === "新会话" ? getSessionTitle(content) : s.title,
      updatedAt: now,
      messages: [...s.messages, userMessage]
    }));
  }

  function stopActiveResponse() {
    if (!activeSession) return;
    const controller = abortControllersRef.current.get(activeSession.id);
    controller?.abort();
    abortControllersRef.current.delete(activeSession.id);
    markSessionIdle(activeSession.id);
  }

  async function processQueuedPrompt(projectId: string, sessionId: string) {
    const next = dequeuePrompt(sessionId);
    if (!next) return false;
    const content =
      next.kind === "guide"
        ? `请把下面内容作为对当前会话/当前任务的引导和补充约束，优先参考，但不要机械复述：\n\n${next.content}`
        : next.content;
    await runAgentForSession(projectId, sessionId, content, true, next.content);
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
    _initialAssistantId: string
  ) {
    let currentAssistantId = _initialAssistantId;
    // 每次工具调用完成后，下一个 text_delta 需要新起一行
    let needNewAssistantRow = false;

    for await (const event of parseSseStream(response)) {
      switch (event.type) {
        case "text_delta": {
          if (needNewAssistantRow) {
            // 新起一行 assistant 消息
            const newId = createId("message");
            currentAssistantId = newId;
            needNewAssistantRow = false;
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: [...s.messages, { id: newId, role: "assistant" as const, content: event.content ?? "", isStreaming: true }]
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

        case "tool_call":
          if (event.toolCall) {
            // 标记当前 assistant 消息不再流式
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === currentAssistantId ? { ...m, isStreaming: false } : m
              )
            }));
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: [
                ...s.messages,
                {
                  id: createId("message"),
                  role: "tool" as const,
                  content: "",
                  toolName: event.toolCall!.name,
                  toolArgs: event.toolCall!.arguments,
                  status: "running" as const
                }
              ]
            }));
          }
          break;

        case "tool_result":
          if (event.result) {
            updateSession(projectId, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.status === "running" && m.role === "tool"
                  ? {
                      ...m,
                      content: event.result!.content,
                      toolResult: { ok: event.result!.ok, content: event.result!.content },
                      diff: event.result!.diff,
                      status: "completed" as const
                    }
                  : m
              )
            }));
            // 下一个 text_delta 需要新起一行
            needNewAssistantRow = true;
          }
          break;

        case "approval_required":
          updateSession(projectId, sessionId, (s) => ({
            ...s,
            conversationId: event.conversationId || s.conversationId,
            pendingApprovals: event.approvals ?? [],
            messages: s.messages.map((m) =>
              m.id === currentAssistantId
                ? { ...m, isStreaming: false, status: "approval_required" as const, content: m.content || "需要你批准后才能继续执行。" }
                : m
            )
          }));
          break;

        case "completed":
          updateSession(projectId, sessionId, (s) => ({
            ...s,
            conversationId: event.conversationId || s.conversationId,
            pendingApprovals: [],
            messages: s.messages.map((m) =>
              m.id === currentAssistantId
                ? { ...m, isStreaming: false, status: "completed" as const, content: m.content || event.answer || "任务已完成。" }
                : m
            )
          }));
          break;

        case "error":
          updateSession(projectId, sessionId, (s) => ({
            ...s,
            pendingApprovals: [],
            messages: s.messages.map((m) =>
              m.id === currentAssistantId
                ? { ...m, isStreaming: false, status: "error" as const, content: event.message || "发生错误。" }
                : m
            )
          }));
          break;
      }
    }
  }

  async function runAgentForSession(
    projectId: string,
    sessionId: string,
    content: string,
    addUserMessage = true,
    displayContent = content
  ) {
    const context = getSessionContext(projectId, sessionId);
    if (!context) return;

    if (addUserMessage) appendUserMessage(projectId, sessionId, displayContent);

    const assistantMessageId = createId("message");
    updateSession(projectId, sessionId, (s) => ({
      ...s,
      updatedAt: new Date().toISOString(),
      messages: [...s.messages, { id: assistantMessageId, role: "assistant", content: "", isStreaming: true }]
    }));

    const abortController = new AbortController();
    abortControllersRef.current.set(sessionId, abortController);
    markSessionRunning(sessionId);

    try {
      const result = await fetch(`${API_BASE}/api/agent/run`, {
        method: "POST",
        signal: abortController.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: content,
          mode,
          conversationId: context.session.conversationId,
          model: modelName,
          thinkingMode,
          projectPath: context.project.path
        })
      });

      await consumeSseStream(result, projectId, sessionId, assistantMessageId);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        updateSession(projectId, sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMessageId ? { ...m, isStreaming: false, content: m.content + "\n\n已停止当前回复。" } : m
          )
        }));
      } else {
        updateSession(projectId, sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMessageId
              ? { ...m, isStreaming: false, status: "error" as const, content: error instanceof Error ? error.message : "请求失败" }
              : m
          )
        }));
      }
    } finally {
      if (abortControllersRef.current.get(sessionId) === abortController) abortControllersRef.current.delete(sessionId);
    markSessionIdle(sessionId);
      void processNextQueuedPrompt(sessionId);
    }
  }

  async function runAgent(nextPrompt = prompt) {
    const content = nextPrompt.trim();
    if (!content || !activeProject || !activeSession) return;

    if (isActiveSessionRunning) {
      enqueuePrompt(activeSession.id, content);
      setPrompt("");
      return;
    }

    setPrompt("");
    await runAgentForSession(activeProject.id, activeSession.id, content);
  }

  async function decideApproval(approvalId: string, allow: boolean) {
    if (!activeProject || !activeSession || isActiveSessionRunning) return;

    const projectId = activeProject.id;
    const sessionId = activeSession.id;
    const assistantMessageId = createId("message");
    updateSession(projectId, sessionId, (s) => ({
      ...s,
      pendingApprovals: [],
      messages: [...s.messages, { id: assistantMessageId, role: "assistant", content: "", isStreaming: true }]
    }));

    const abortController = new AbortController();
    abortControllersRef.current.set(sessionId, abortController);
    markSessionRunning(sessionId);

    try {
      const result = await fetch(`${API_BASE}/api/agent/approve`, {
        method: "POST",
        signal: abortController.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approvalId,
          allow,
          mode,
          model: modelName,
          thinkingMode,
          projectPath: activeProject.path
        })
      });

      await consumeSseStream(result, projectId, sessionId, assistantMessageId);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        updateSession(projectId, sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMessageId
              ? { ...m, isStreaming: false, status: "error" as const, content: error instanceof Error ? error.message : "请求失败" }
              : m
          )
        }));
      }
    } finally {
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

  return (
    <main className="desktopShell" data-client={isDesktopClient ? "electron" : "web"} data-theme={resolvedTheme}>
      <section className="clientWindow">
        {isDesktopClient && (
          <div className="appTopBar">
            <div className="topBarSidebarZone">
              <div className="appTopBarTrafficSpace" />
              <button className="topBarIconButton" type="button" aria-label="切换侧边栏">
                <PanelLeft size={16} />
              </button>
              <button className="topBarIconButton muted" type="button" aria-label="返回">
                <SquareChevronLeft size={16} />
              </button>
              <button className="topBarIconButton muted" type="button" aria-label="前进">
                <SquareChevronRight size={16} />
              </button>
            </div>
            <div className="topBarMainZone">
              <div className="topBarTitle">
                <MessageSquarePlus size={17} />
                <span>{activeSession?.title ?? "Agent Console"}</span>
                <button className="topBarGhostButton" type="button" aria-label="更多">
                  <MoreHorizontal size={18} />
                </button>
              </div>
              <div className="topBarSpacer" />
              <button className="topBarModelButton" type="button" title={modelName}>
                <span>{modelName}</span>
                <ChevronDown size={15} />
              </button>
              <button className="topBarIconButton" type="button" aria-label="视图选项">
                <ListFilter size={17} />
              </button>
              <button className="topBarIconButton" type="button" aria-label="布局选项">
                <SlidersHorizontal size={17} />
              </button>
              <button className="topBarIconButton" type="button" aria-label="右侧面板">
                <PanelRight size={17} />
              </button>
            </div>
          </div>
        )}
        <div className={`appLayout ${diffPanel ? "hasDiffPanel" : ""}`}>
          <aside className="sidebar projectSidebar" aria-label="项目与会话">
            <div className="projectSidebarHeader">
              <div>
                <span>项目</span>
                <strong>{workspaceState.projects.length}</strong>
              </div>
              <button className="iconButton" type="button" onClick={() => addSession()} aria-label="新会话">
                <MessageSquarePlus size={16} />
              </button>
            </div>

            <div className="projectActions" aria-label="项目操作">
              <button type="button" onClick={addEmptyProject}>
                <Plus size={15} />
                空项目
              </button>
              <button type="button" onClick={() => void addFolderProject()}>
                <FolderOpen size={15} />
                电脑文件夹
              </button>
              <button type="button" onClick={() => void createFolderProject()}>
                <FolderPlus size={15} />
                自建文件夹
              </button>
            </div>

            <div className="projectList">
              {workspaceState.projects.map((project) => {
                const isActiveProject = project.id === activeProject?.id;
                const visibleSessions = project.sessions.filter((session) => !session.archivedAt);
                return (
                  <section className="projectGroup" key={project.id}>
                    <button
                      className={`projectRow ${isActiveProject ? "active" : ""}`}
                      type="button"
                      onClick={() => selectProject(project)}
                    >
                      {project.kind === "folder" ? <Folder size={18} /> : <HardDrive size={18} />}
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.path ?? "空项目"}</small>
                      </span>
                    </button>

                    <div className="sessionList">
                      {visibleSessions.length === 0 && <div className="emptySession">暂无对话</div>}
                      {visibleSessions.map((session) => (
                        <div
                          className={`sessionSwipeRow ${swipedSessionId === session.id ? "swiped" : ""}`}
                          key={session.id}
                        >
                          <button
                            className="sessionArchiveAction"
                            type="button"
                            onClick={() => archiveSession(project.id, session.id)}
                          >
                            <Archive size={14} />
                            归档
                          </button>
                          <button
                            className={`sessionRow ${
                              project.id === activeProject?.id && session.id === activeSession?.id ? "active" : ""
                            } ${runningSessionIds.has(session.id) ? "running" : ""}`}
                            type="button"
                            onClick={() => {
                              if (swipedSessionId === session.id) {
                                setSwipedSessionId(undefined);
                                return;
                              }
                              selectSession(project.id, session.id);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              archiveSession(project.id, session.id);
                            }}
                            onPointerDown={(event) => handleSessionPointerDown(session.id, event)}
                            onPointerMove={(event) => handleSessionPointerMove(session.id, event)}
                            onPointerUp={(event) => handleSessionPointerUp(project.id, session.id, event)}
                            onPointerCancel={(event) => {
                              swipeStartRef.current.delete(session.id);
                              releaseSessionPointer(event);
                            }}
                          >
                            <span className="sessionTitle">
                              {runningSessionIds.has(session.id) && <span className="sessionRunningDot" aria-hidden="true" />}
                              <span className="sessionTitleText">{session.title}</span>
                            </span>
                            <time>{getRelativeTime(session.updatedAt)}</time>
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </aside>

          <section className="workspace">
            <section className="agentGrid">
              <div className="leftStack">
                <section className="chatPanel">
                  <div className="composerHeader chatHeader">
                    <div className="chatHeaderTitle">
                      <h2>{activeSession?.title ?? "上下文会话"}</h2>
                      <p>
                        {activeProject?.name ?? "未选择项目"}
                        {conversationId ? ` · Conversation ${conversationId.slice(0, 8)}` : " · 新会话"}
                      </p>
                    </div>
                    <button className="newChatButton" type="button" onClick={() => addSession()}>
                      <MessageSquarePlus size={16} />
                      新会话
                    </button>
                  </div>

                  <div className="messageList" aria-live="polite">
                    {(() => {
                      // 把连续的 tool 消息合并成一个折叠行
                      type RenderItem =
                        | { type: "single"; message: ChatMessage }
                        | { type: "toolGroup"; messages: ChatMessage[] };
                      const renderItems: RenderItem[] = [];
                      let currentToolGroup: ChatMessage[] = [];
                      for (const message of visibleMessages) {
                        if (message.role === "tool") {
                          currentToolGroup.push(message);
                        } else {
                          if (currentToolGroup.length > 0) {
                            renderItems.push({ type: "toolGroup", messages: currentToolGroup });
                            currentToolGroup = [];
                          }
                          renderItems.push({ type: "single", message });
                        }
                      }
                      if (currentToolGroup.length > 0) {
                        renderItems.push({ type: "toolGroup", messages: currentToolGroup });
                      }

                      return renderItems.map((item) => {
                        if (item.type === "toolGroup") {
                          const toolMessages = item.messages;
                          const runningCount = toolMessages.filter((m) => m.status === "running").length;
                          const failCount = toolMessages.filter((m) => m.status === "completed" && m.toolResult && !m.toolResult.ok).length;
                          const hasRunning = runningCount > 0;
                          const groupSummary = getToolGroupSummary(toolMessages);
                          const groupId = `group-${toolMessages[0].id}`;
                          const isManuallyClosed = manualClosedGroupsRef.current.has(groupId);
                          // 用户手动关闭后不再自动打开；否则运行时自动展开
                          const isOpen = !isManuallyClosed && hasRunning;

                          return (
                            <details
                              className={`toolToggle ${groupSummary.isRunning ? "running" : ""}`}
                              key={groupId}
                              open={isOpen}
                              onToggle={(e) => {
                                // 用户手动关闭时记录，避免后续重渲染自动展开
                                if (!(e.currentTarget as HTMLDetailsElement).open) {
                                  manualClosedGroupsRef.current.add(groupId);
                                }
                              }}
                            >
                              <summary className="toolToggleSummary">
                                {groupSummary.primaryTool === "write_file" ? (
                                  <Pencil size={17} strokeWidth={2} />
                                ) : groupSummary.primaryTool === "read_file" ? (
                                  <FileText size={17} strokeWidth={2} />
                                ) : (
                                  <Terminal size={17} strokeWidth={2} />
                                )}
                                <span className="toolToggleCopy">
                                  <span className="toolToggleText">{groupSummary.label}</span>
                                  {groupSummary.detail && (
                                    <span className="toolToggleDetail">
                                      {groupSummary.detail}
                                      {(groupSummary.addedLines > 0 || groupSummary.removedLines > 0) && (
                                        <span className="toolDiffInline">
                                          {groupSummary.addedLines > 0 && <span className="toolDiffAdd">+{groupSummary.addedLines}</span>}
                                          {groupSummary.removedLines > 0 && <span className="toolDiffRemove">-{groupSummary.removedLines}</span>}
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </span>
                                <span className="toolToggleArrow">&gt;</span>
                                {failCount > 0 && <span className="toolToggleFail">{failCount} 失败</span>}
                              </summary>
                              <div className="toolToggleBody">
                                {toolMessages.map((message) => {
                                  const isRunning = message.status === "running";
                                  const summary = getToolDisplayTarget(message);
                                  const addedLines = message.diff?.addedLines ?? 0;
                                  const removedLines = message.diff?.removedLines ?? 0;
                                  return (
                                    <div className={`toolToggleItem ${isRunning ? "running" : ""}`} key={message.id}>
                                      <div className="toolToggleItemHead">
                                        <span className={`toolCardDot ${isRunning ? "running" : message.toolResult?.ok ? "ok" : "fail"}`} />
                                        <span className="toolCardName">{message.toolName}</span>
                                        {summary && <span className="toolCardDesc">{summary}</span>}
                                        {(addedLines > 0 || removedLines > 0) && (
                                          <span className="toolDiffInline compact">
                                            {addedLines > 0 && <span className="toolDiffAdd">+{addedLines}</span>}
                                            {removedLines > 0 && <span className="toolDiffRemove">-{removedLines}</span>}
                                          </span>
                                        )}
                                        <span className={`toolCardStatus ${isRunning ? "running" : message.toolResult?.ok ? "ok" : "fail"}`}>
                                          {isRunning ? "运行中" : message.toolResult?.ok ? "完成" : "失败"}
                                        </span>
                                      </div>
                                      {(message.toolArgs || message.toolResult) && (
                                        <div className="toolCardBody">
                                          {message.toolArgs && (
                                            <div className="toolCardSection">
                                              <div className="toolCardLabel">参数</div>
                                              <pre className="toolCardPre">{summarizeArguments(message.toolArgs)}</pre>
                                            </div>
                                          )}
                                          {message.toolResult && (
                                            <div className="toolCardSection">
                                              <div className="toolCardLabel">结果</div>
                                              <pre className="toolCardPre">{message.toolResult.content.slice(0, 1500)}</pre>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          );
                        }

                        const message = item.message;
                        const isAssistant = message.role === "assistant";
                        const isEmpty = !message.content?.trim();
                        const showFinalBadge = message.status === "completed" && !message.isStreaming && !isEmpty;

                        return (
                          <article className={`message ${message.role} ${isEmpty && message.isStreaming ? "streamingOnly" : ""}`} key={message.id}>
                            {message.role !== "user" && (
                              <div className="messageMeta">
                                <span>{modelName}</span>
                                {message.isStreaming && <strong className="streaming">typing</strong>}
                                {message.status === "error" && <strong className="toolFail">error</strong>}
                                {message.status === "approval_required" && <strong>approval_required</strong>}
                                {showFinalBadge && <strong className="finalBadge">最终回复</strong>}
                              </div>
                            )}
                            {!isEmpty && (
                              <div className={`messageBubble ${isAssistant ? "assistantBubble" : ""}`}>
                                {renderMessageContent(message.content)}
                                {message.isStreaming && <span className="streamingCursor">▊</span>}
                              </div>
                            )}
                            {isEmpty && message.isStreaming && (
                              <div className="messageBubble assistantBubble streamingPlaceholder">
                                <span className="thinkingFlow">正在思考</span>
                              </div>
                            )}
                          </article>
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

                    {/* 变更汇总 */}
                    {(() => {
                      const fileDiffs = messages
                        .filter((m) => m.role === "tool" && m.diff && m.status === "completed")
                        .map((m) => m.diff!);
                      if (fileDiffs.length === 0) return null;
                      // 合并同一文件多次写入，保留最后一次
                      const merged = new Map<string, DiffResult>();
                      for (const d of fileDiffs) {
                        merged.set(d.filePath, d);
                      }
                      const diffs = [...merged.values()];
                      const totalAdded = diffs.reduce((s, d) => s + d.addedLines, 0);
                      const totalRemoved = diffs.reduce((s, d) => s + d.removedLines, 0);

                      return (
                        <div className="diffSummary">
                          <div className="diffSummaryHeader">
                            <span className="diffSummaryTitle">变更汇总</span>
                            <span className="diffSummaryStats">
                              <span className="diffAdded">+{totalAdded}</span>
                              <span className="diffRemoved">-{totalRemoved}</span>
                            </span>
                          </div>
                          {diffs.map((d) => (
                            <button
                              key={d.filePath}
                              type="button"
                              className="diffSummaryFile"
                              onClick={() => setDiffPanel(d)}
                            >
                              <span className="diffFileIcon">{d.oldContent === null ? "N" : "M"}</span>
                              <span className="diffFileName">{d.filePath.split(/[\\/]/).pop()}</span>
                              <span className="diffFileDir">{d.filePath}</span>
                              <span className="diffFileStats">
                                <span className="diffAdded">+{d.addedLines}</span>
                                <span className="diffRemoved">-{d.removedLines}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      );
                    })()}

	                    <div ref={messagesEndRef} />
	                  </div>

	                  {activeQueuedPrompts.length > 0 && activeSession && (
	                    <div className="queuePanel" aria-label="排队中的后续请求">
	                      {activeQueuedPrompts.map((item, index) => (
	                        <div className={`queueItem ${item.kind === "guide" ? "guide" : ""}`} key={item.id}>
	                          <CornerDownRight size={15} />
	                          <span className="queueItemText">
	                            {item.kind === "guide" && <strong>引导</strong>}
	                            {item.content}
	                          </span>
	                          <span className="queueItemMeta">{index === 0 ? "下一个" : `#${index + 1}`}</span>
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

	                  <div className="chatComposer">
	                    <textarea
	                      aria-label="聊天输入框"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      placeholder="输入任务，Enter 发送，Shift + Enter 换行"
                      rows={1}
                    />
                    <div className="composerFooter">
                      <div className="composerControls">
                        <div className="modelPicker">
                          <button
                            className="modelPickerButton"
                            type="button"
                            onClick={() => setModelMenuOpen((open) => !open)}
                          >
                            <span>{modelName}</span>
                            <ChevronDown size={14} />
                          </button>
                          {modelMenuOpen && (
                            <div className="modelMenu">
                              {(modelOptions.length > 0 ? modelOptions : [modelName]).map((model) => (
                                <button
                                  className={model === modelName ? "active" : ""}
                                  key={model}
                                  type="button"
                                  onClick={() => {
                                    setSelectedModel(model);
                                    setModelMenuOpen(false);
                                  }}
                                >
                                  {model}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <label className="thinkingMode">
                          <Brain size={14} />
                          <select
                            value={thinkingMode}
                            onChange={(event) => setThinkingMode(event.target.value as ThinkingMode)}
                          >
                            {thinkingOptions.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        {activeQueueLength > 0 && <span className="queueBadge">队列 {activeQueueLength}</span>}
                      </div>
                      <div className="composerActions">
                        <div className="permissionPicker">
                          <button
                            className="permissionModeButton"
                            type="button"
                            title={selectedPermission.description}
                            onClick={() => setPermissionMenuOpen((open) => !open)}
                          >
                            <span>{selectedPermission.label}</span>
                            <ChevronDown size={14} />
                          </button>
                          {permissionMenuOpen && (
                            <div className="permissionMenu">
                              {permissionOptions.map((item) => (
                                <button
                                  className={item.id === mode ? "active" : ""}
                                  key={item.id}
                                  type="button"
                                  onClick={() => {
                                    setMode(item.id);
                                    setPermissionMenuOpen(false);
                                  }}
                                >
                                  <span>
                                    <strong>{item.label}</strong>
                                    <small>{item.description}</small>
                                  </span>
                                  {item.id === mode && <Check size={16} />}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          className={`sendButton ${isActiveSessionRunning ? "stopping" : ""}`}
                          type="button"
                          onClick={handleSendButtonClick}
                          disabled={!isActiveSessionRunning && !prompt.trim()}
                          aria-label={isActiveSessionRunning ? "停止回复" : "发送"}
                        >
                          {isActiveSessionRunning ? <Square size={15} /> : <Send size={17} />}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </section>
          </section>
        </div>
        {/* 右侧 diff 对比面板 */}
        {diffPanel && (
          <aside className="diffPanel">
            <div className="diffPanelHeader">
              <div className="diffPanelFileInfo">
                <span className="diffPanelFileName">{diffPanel.filePath.split(/[\\/]/).pop()}</span>
                <span className="diffPanelPath">{diffPanel.filePath}</span>
              </div>
              <div className="diffPanelStats">
                <span className="diffAdded">+{diffPanel.addedLines}</span>
                <span className="diffRemoved">-{diffPanel.removedLines}</span>
              </div>
              <button className="diffPanelClose" type="button" onClick={() => setDiffPanel(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="diffPanelContent">
              <table className="diffTable">
                <tbody>
                  {diffPanel.lines.map((line, idx) => (
                    <tr key={idx} className={`diffLine ${line.type}`}>
                      <td className="diffLineNum">{line.oldLine ?? ""}</td>
                      <td className="diffLineNum">{line.newLine ?? ""}</td>
                      <td className="diffLineSign">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</td>
                      <td className="diffLineContent"><pre>{line.content}</pre></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </aside>
        )}
      </section>
    </main>
  );
}
