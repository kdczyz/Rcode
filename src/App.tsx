import {
  AlertTriangle,
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
  X
} from "lucide-react";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type PermissionMode = "request_approval" | "auto_approve" | "full_access";
type ThemePreference = "system" | "dark" | "light";
type ThinkingMode = "fast" | "balanced" | "deep";
type ProjectKind = "empty" | "folder";

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
  role: "user" | "assistant";
  content: string;
  status?: AgentRunResponse["status"];
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

interface AgentRunResponse {
  conversationId: string;
  status: "completed" | "approval_required" | "error";
  answer?: string;
  error?: string;
  pendingApprovals?: PendingApproval[];
  toolResults?: Array<{
    name: string;
    ok: boolean;
    content: string;
  }>;
}

interface ProjectSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  conversationId?: string;
  messages: ChatMessage[];
  pendingApprovals: PendingApproval[];
  response?: AgentRunResponse;
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
  if (!value || typeof value !== "object") {
    return false;
  }

  const state = value as WorkspaceState;
  return (
    Array.isArray(state.projects) &&
    typeof state.activeProjectId === "string" &&
    typeof state.activeSessionId === "string"
  );
}

function loadWorkspaceState(): WorkspaceState {
  try {
    const parsed = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null");
    if (isWorkspaceState(parsed) && parsed.projects.length > 0) {
      return parsed;
    }
  } catch {
    // Ignore corrupt local state and recreate a small default workspace.
  }

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

  if (elapsed < minute) {
    return "刚刚";
  }

  if (elapsed < hour) {
    return `${Math.max(1, Math.floor(elapsed / minute))} 分`;
  }

  if (elapsed < day) {
    return `${Math.floor(elapsed / hour)} 时`;
  }

  if (elapsed < week) {
    return `${Math.floor(elapsed / day)} 天`;
  }

  return `${Math.floor(elapsed / week)} 周`;
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
  const [runningSessionId, setRunningSessionId] = useState<string>();
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const queuedPromptsRef = useRef<Map<string, QueuedPrompt[]>>(new Map());
  const [queueVersion, setQueueVersion] = useState(0);

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
  const response = activeSession?.response;
  const pendingApprovals = activeSession?.pendingApprovals ?? [];
  const conversationId = activeSession?.conversationId;
  const isRunning = Boolean(runningSessionId);
  const isActiveSessionRunning = runningSessionId === activeSession?.id;
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
      .then((result) => result.json())
      .then((data) => {
        setHealth(data);
        setSelectedModel((current) => current || data.model || "");
      })
      .catch(() => setHealth(undefined));
  }, []);

  useEffect(() => {
    fetch("/api/models")
      .then((result) => result.json())
      .then((catalog: ModelCatalog) => {
        const recommended = catalog.recommendedForAgent ?? [];
        const all = catalog.models?.map((model) => model.id) ?? [];
        const merged = [...new Set([...recommended, ...all])];
        setModelOptions(merged);
      })
      .catch(() => setModelOptions([]));
  }, []);

  useEffect(() => {
    fetch("/api/permissions")
      .then((result) => result.json())
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
    const handleChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? "dark" : "light");
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [workspaceState.activeSessionId, messages.length, pendingApprovals.length, isRunning]);

  function updateSession(projectId: string, sessionId: string, updater: (session: ProjectSession) => ProjectSession) {
    setWorkspaceState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              updatedAt: new Date().toISOString(),
              sessions: project.sessions.map((session) => (session.id === sessionId ? updater(session) : session))
            }
          : project
      )
    }));
  }

  function selectProject(project: AgentProject) {
    const firstSession = project.sessions[0] ?? createSession();
    setWorkspaceState((current) => ({
      ...current,
      projects: current.projects.map((item) =>
        item.id === project.id && item.sessions.length === 0 ? { ...item, sessions: [firstSession] } : item
      ),
      activeProjectId: project.id,
      activeSessionId: firstSession.id
    }));
  }

  function selectSession(projectId: string, sessionId: string) {
    setWorkspaceState((current) => ({
      ...current,
      activeProjectId: projectId,
      activeSessionId: sessionId
    }));
  }

  function addProject(project: AgentProject) {
    setWorkspaceState((current) => ({
      projects: [project, ...current.projects],
      activeProjectId: project.id,
      activeSessionId: project.sessions[0].id
    }));
  }

  function addEmptyProject() {
    const name = window.prompt("空项目名称", "空项目");
    if (!name?.trim()) {
      return;
    }

    addProject(createProject(name.trim(), "empty"));
  }

  async function addFolderProject() {
    const folderPath = await window.agentDesktop?.selectProjectFolder?.();
    if (!folderPath) {
      return;
    }

    addProject(createProject(getFolderName(folderPath), "folder", folderPath));
  }

  async function createFolderProject() {
    const name = window.prompt("新建文件夹项目名称", "新项目");
    if (!name?.trim()) {
      return;
    }

    const folderPath = await window.agentDesktop?.createFolderProject?.(name.trim());
    addProject(createProject(name.trim(), folderPath ? "folder" : "empty", folderPath));
  }

  function addSession(projectId = workspaceState.activeProjectId) {
    const session = createSession();
    setWorkspaceState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? { ...project, updatedAt: session.updatedAt, sessions: [session, ...project.sessions] }
          : project
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
    return workspaceStateRef.current.projects.find((project) =>
      project.sessions.some((session) => session.id === sessionId)
    )?.id;
  }

  function updateQueueState() {
    setQueueVersion((version) => version + 1);
  }

  function enqueuePrompt(projectId: string, sessionId: string, content: string) {
    const currentQueue = queuedPromptsRef.current.get(sessionId) ?? [];
    queuedPromptsRef.current.set(sessionId, [...currentQueue, { id: createId("queue"), content }]);
    updateQueueState();
  }

  function dequeuePrompt(sessionId: string) {
    const currentQueue = queuedPromptsRef.current.get(sessionId) ?? [];
    const [nextPrompt, ...rest] = currentQueue;
    if (rest.length > 0) {
      queuedPromptsRef.current.set(sessionId, rest);
    } else {
      queuedPromptsRef.current.delete(sessionId);
    }
    updateQueueState();
    return nextPrompt;
  }

  function appendUserMessage(projectId: string, sessionId: string, content: string) {
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: createId("message"), role: "user", content };
    updateSession(projectId, sessionId, (session) => ({
      ...session,
      title: session.title === "新会话" ? getSessionTitle(content) : session.title,
      updatedAt: now,
      messages: [...session.messages, userMessage]
    }));
  }

  function stopActiveResponse() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setRunningSessionId(undefined);
  }

  async function processQueuedPrompt(projectId: string, sessionId: string) {
    const nextPrompt = dequeuePrompt(sessionId);
    if (!nextPrompt) {
      return false;
    }

    await runAgentForSession(projectId, sessionId, nextPrompt.content, false);
    return true;
  }

  async function processNextQueuedPrompt(preferredSessionId?: string) {
    if (preferredSessionId) {
      const preferredProjectId = findProjectIdForSession(preferredSessionId);
      if (preferredProjectId && (queuedPromptsRef.current.get(preferredSessionId)?.length ?? 0) > 0) {
        await processQueuedPrompt(preferredProjectId, preferredSessionId);
        return;
      }
    }

    for (const [sessionId, queue] of queuedPromptsRef.current.entries()) {
      const projectId = findProjectIdForSession(sessionId);
      if (projectId && queue.length > 0) {
        await processQueuedPrompt(projectId, sessionId);
        return;
      }
    }
  }

  async function runAgentForSession(projectId: string, sessionId: string, content: string, addUserMessage = true) {
    const context = getSessionContext(projectId, sessionId);
    if (!context) {
      return;
    }

    if (addUserMessage) {
      appendUserMessage(projectId, sessionId, content);
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setRunningSessionId(sessionId);

    try {
      const latestContext = getSessionContext(projectId, sessionId);
      if (!latestContext) {
        return;
      }

      const result = await fetch("/api/agent/run", {
        method: "POST",
        signal: abortController.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: content,
          mode,
          conversationId: latestContext.session.conversationId,
          model: modelName,
          thinkingMode,
          projectPath: latestContext.project.path
        })
      });
      const data = (await result.json()) as AgentRunResponse;
      const assistantMessage: ChatMessage = {
        id: createId("message"),
        role: "assistant",
        status: data.status,
        content:
          data.error ||
          data.answer ||
          (data.status === "approval_required" ? "需要你批准后才能继续执行。" : "任务已完成。")
      };

      updateSession(projectId, sessionId, (session) => ({
        ...session,
        conversationId: data.conversationId || session.conversationId,
        response: data,
        pendingApprovals: data.pendingApprovals ?? [],
        updatedAt: new Date().toISOString(),
        messages: [...session.messages, assistantMessage]
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const stoppedMessage: ChatMessage = {
          id: createId("message"),
          role: "assistant",
          content: "已停止当前回复。"
        };
        updateSession(projectId, sessionId, (session) => ({
          ...session,
          updatedAt: new Date().toISOString(),
          messages: [...session.messages, stoppedMessage]
        }));
      } else {
        const errorMessage: ChatMessage = {
          id: createId("message"),
          role: "assistant",
          status: "error",
          content: error instanceof Error ? error.message : "请求失败"
        };
        updateSession(projectId, sessionId, (session) => ({
          ...session,
          updatedAt: new Date().toISOString(),
          messages: [...session.messages, errorMessage]
        }));
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setRunningSessionId(undefined);
      void processNextQueuedPrompt(sessionId);
    }
  }

  async function runAgent(nextPrompt = prompt) {
    const content = nextPrompt.trim();
    if (!content || !activeProject || !activeSession) {
      return;
    }

    if (isRunning) {
      enqueuePrompt(activeProject.id, activeSession.id, content);
      appendUserMessage(activeProject.id, activeSession.id, content);
      setPrompt("");
      return;
    }

    setPrompt("");
    await runAgentForSession(activeProject.id, activeSession.id, content);
  }

  async function decideApproval(approvalId: string, allow: boolean) {
    if (!activeProject || !activeSession || isRunning) {
      return;
    }

    const projectId = activeProject.id;
    const sessionId = activeSession.id;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setRunningSessionId(sessionId);

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
      const data = (await result.json()) as AgentRunResponse;
      const assistantMessage: ChatMessage = {
        id: createId("message"),
        role: "assistant",
        status: data.status,
        content: data.error || data.answer || (allow ? "已允许工具调用。" : "已拒绝工具调用。")
      };

      updateSession(projectId, sessionId, (session) => ({
        ...session,
        response: data,
        pendingApprovals: data.pendingApprovals ?? [],
        updatedAt: new Date().toISOString(),
        messages: [...session.messages, assistantMessage]
      }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const errorMessage: ChatMessage = {
          id: createId("message"),
          role: "assistant",
          status: "error",
          content: error instanceof Error ? error.message : "请求失败"
        };
        updateSession(projectId, sessionId, (session) => ({
          ...session,
          updatedAt: new Date().toISOString(),
          messages: [...session.messages, errorMessage]
        }));
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setRunningSessionId(undefined);
      void processNextQueuedPrompt(sessionId);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

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
        <div className="appLayout">
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
                          }`}
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
                    {messages.map((message) => (
                      <article className={`message ${message.role}`} key={message.id}>
                        <div className="messageMeta">
                          <span>{message.role === "user" ? "你" : modelName}</span>
                          {message.status && <strong>{message.status}</strong>}
                        </div>
                        <div className="messageBubble">{message.content}</div>
                      </article>
                    ))}

                    {isActiveSessionRunning && (
                      <article className="message assistant">
                        <div className="messageMeta">
                          <span>{modelName}</span>
                          <strong>thinking</strong>
                        </div>
                        <div className="messageBubble typingBubble">
                          <span />
                          <span />
                          <span />
                        </div>
                      </article>
                    )}

                    {response?.status === "error" && (
                      <div className="notice error">
                        <AlertTriangle size={18} />
                        {response.error}
                      </div>
                    )}

                    {response?.toolResults && response.toolResults.length > 0 && (
                      <div className="toolResults">
                        {response.toolResults.map((result, index) => (
                          <details key={`${result.name}-${index}`}>
                            <summary>
                              {result.ok ? "完成" : "失败"} · {result.name}
                            </summary>
                            <pre>{result.content}</pre>
                          </details>
                        ))}
                      </div>
                    )}

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
      </section>
    </main>
  );
}
