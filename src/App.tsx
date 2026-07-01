import {
  Brain,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MessageSquarePlus,
  Plus,
  Send,
  Square,
  Terminal,
  X
} from "lucide-react";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

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
const thinkingOptions: Array<{ id: ThinkingMode; label: string }> = [
  { id: "fast", label: "快速" },
  { id: "balanced", label: "标准" },
  { id: "deep", label: "深度" }
];

const defaultPermissionOptions: PermissionOption[] = [
  { id: "request_approval", label: "请求批准", description: "编辑外部文件和使用互联网时始终询问" },
  { id: "auto_approve", label: "替我审批", description: "仅对检测到的风险操作请求批准" },
  { id: "full_access", label: "完全访问", description: "可不受限制地访问互联网和本机文件" }
];

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
  const [queueVersion, setQueueVersion] = useState(0);
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
  const activeQueueLength = useMemo(
    () => (activeSession ? (queuedPromptsRef.current.get(activeSession.id)?.length ?? 0) : 0),
    [activeSession, queueVersion]
  );

  useEffect(() => {
    workspaceStateRef.current = workspaceState;
    localStorage.setItem(workspaceStorageKey, JSON.stringify(workspaceState));
  }, [workspaceState]);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        setHealth(data);
        setSelectedModel((cur) => cur || data.model || "");
      })
      .catch(() => setHealth(undefined));
  }, []);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((catalog: ModelCatalog) => {
        const recommended = catalog.recommendedForAgent ?? [];
        const all = catalog.models?.map((m) => m.id) ?? [];
        setModelOptions([...new Set([...recommended, ...all])]);
      })
      .catch(() => setModelOptions([]));
  }, []);

  useEffect(() => {
    fetch("/api/permissions")
      .then((r) => r.json())
      .then((catalog: PermissionCatalog) => {
        const defaults = new Map(defaultPermissionOptions.map((item) => [item.id, item]));
        const merged = (catalog.modes ?? defaultPermissionOptions).map((item) => ({
          id: item.id,
          label: defaults.get(item.id)?.label ?? item.id,
          description: item.description ?? defaults.get(item.id)?.description ?? ""
        }));
        setPermissionOptions(merged);
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
    const firstSession = project.sessions[0] ?? createSession();
    setWorkspaceState((cur) => ({
      ...cur,
      projects: cur.projects.map((item) =>
        item.id === project.id && item.sessions.length === 0 ? { ...item, sessions: [firstSession] } : item
      ),
      activeProjectId: project.id,
      activeSessionId: firstSession.id
    }));
  }

  function selectSession(projectId: string, sessionId: string) {
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

  function enqueuePrompt(projectId: string, sessionId: string, content: string) {
    const q = queuedPromptsRef.current.get(sessionId) ?? [];
    queuedPromptsRef.current.set(sessionId, [...q, { id: createId("queue"), content }]);
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
    await runAgentForSession(projectId, sessionId, next.content, false);
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

  async function runAgentForSession(projectId: string, sessionId: string, content: string, addUserMessage = true) {
    const context = getSessionContext(projectId, sessionId);
    if (!context) return;

    if (addUserMessage) appendUserMessage(projectId, sessionId, content);

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
      const result = await fetch("/api/agent/run", {
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
      enqueuePrompt(activeProject.id, activeSession.id, content);
      appendUserMessage(activeProject.id, activeSession.id, content);
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
      const result = await fetch("/api/agent/approve", {
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
                      {project.sessions.length === 0 && <div className="emptySession">暂无对话</div>}
                      {project.sessions.map((session) => (
                        <button
                          className={`sessionRow ${
                            project.id === activeProject?.id && session.id === activeSession?.id ? "active" : ""
                          } ${runningSessionIds.has(session.id) ? "running" : ""}`}
                          key={session.id}
                          type="button"
                          onClick={() => selectSession(project.id, session.id)}
                        >
                          <span>{session.title}</span>
                          <time>{getRelativeTime(session.updatedAt)}</time>
                        </button>
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
                    <div>
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
                      for (const message of messages) {
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
                          const doneCount = toolMessages.filter((m) => m.status === "completed").length;
                          const failCount = toolMessages.filter((m) => m.status === "completed" && m.toolResult && !m.toolResult.ok).length;
                          const hasRunning = runningCount > 0;
                          const allDone = doneCount === toolMessages.length;
                          const toolNames = [...new Set(toolMessages.map((m) => m.toolName))];
                          const groupId = `group-${toolMessages[0].id}`;
                          const isManuallyClosed = manualClosedGroupsRef.current.has(groupId);
                          // 用户手动关闭后不再自动打开；否则运行时自动展开
                          const isOpen = !isManuallyClosed && hasRunning;

                          return (
                            <details
                              className="toolToggle"
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
                                <span className="toolToggleArrow">&gt;</span>
                                <span className="toolToggleText">
                                  {hasRunning
                                    ? `正在调用工具 ${toolNames.join(", ")}...`
                                    : allDone
                                      ? `已调用 ${toolNames.join(", ")}（${toolMessages.length} 次）`
                                      : `工具调用 ${toolNames.join(", ")} (${doneCount}/${toolMessages.length})`}
                                </span>
                                {failCount > 0 && <span className="toolToggleFail">{failCount} 失败</span>}
                              </summary>
                              <div className="toolToggleBody">
                                {toolMessages.map((message) => {
                                  const isRunning = message.status === "running";
                                  const pathArg = message.toolArgs?.path as string;
                                  const commandArg = message.toolArgs?.command as string;
                                  const summary = pathArg
                                    ? pathArg.length > 40 ? `...${pathArg.slice(-37)}` : pathArg
                                    : commandArg
                                      ? commandArg.length > 40 ? `...${commandArg.slice(-37)}` : commandArg
                                      : "";
                                  return (
                                    <div className="toolToggleItem" key={message.id}>
                                      <div className="toolToggleItemHead">
                                        <span className={`toolCardDot ${isRunning ? "running" : message.toolResult?.ok ? "ok" : "fail"}`} />
                                        <span className="toolCardName">{message.toolName}</span>
                                        {summary && <span className="toolCardDesc">{summary}</span>}
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
                            <div className="messageMeta">
                              <span>{message.role === "user" ? "你" : modelName}</span>
                              {message.isStreaming && <strong className="streaming">typing</strong>}
                              {message.status === "error" && <strong className="toolFail">error</strong>}
                              {message.status === "approval_required" && <strong>approval_required</strong>}
                              {showFinalBadge && <strong className="finalBadge">最终回复</strong>}
                            </div>
                            {!isEmpty && (
                              <div className={`messageBubble ${isAssistant ? "assistantBubble" : ""}`}>
                                {message.content}
                                {message.isStreaming && <span className="streamingCursor">▊</span>}
                              </div>
                            )}
                            {isEmpty && message.isStreaming && (
                              <div className="messageBubble assistantBubble streamingPlaceholder">
                                <span className="streamingCursor">▊</span>
                              </div>
                            )}
                          </article>
                        );
                      });
                    })()}

                    {pendingApprovals.length > 0 && (
                      <div className="approvalStack inlineApproval">
                        {pendingApprovals.map((approval) => (
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
