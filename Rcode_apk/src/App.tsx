import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Code2,
  Cpu,
  Folder,
  Image,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  PanelLeftClose,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  Square,
  SquarePen,
  Terminal,
  Wrench,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  ApiError,
  AuthResult,
  createId,
  GeneratedImage,
  readCachedUser,
  readLocalState,
  readToken,
  RemoteCommand,
  RemoteDevice,
  RemoteSnapshot,
  RemoteWorkspaceProject,
  RemoteWorkspaceSession,
  request,
  streamWorkChat,
  User,
  writeCachedUser,
  writeLocalState,
  writeToken
} from "./api";
import { ConnectionState, RemoteController } from "./remote";
import { requestedImageModel } from "./image-model";

type Screen = "work" | "code" | "console" | "settings";
type RunMode = "default" | "plan" | "workspace_write" | "custom" | "full_access";
type ThinkingMode = "fast" | "balanced" | "deep";
type WorkPicker = "provider" | "model" | "thinking" | null;

const RUN_MODES: Array<{ id: RunMode; label: string; short: string }> = [
  { id: "default", label: "默认权限", short: "默认" },
  { id: "plan", label: "仅规划", short: "规划" },
  { id: "workspace_write", label: "工作区读写", short: "工作区" },
  { id: "custom", label: "自定义规则", short: "自定义" },
  { id: "full_access", label: "完全访问", short: "完全访问" }
];

const THINKING_MODES: Array<{ id: ThinkingMode; label: string; description: string }> = [
  { id: "fast", label: "快速", description: "优先响应速度，适合简单问答" },
  { id: "balanced", label: "均衡", description: "兼顾速度与推理质量" },
  { id: "deep", label: "深度", description: "投入更多推理，适合复杂问题" }
];

interface LiveEvent {
  id: string;
  commandId: string;
  type: string;
  text: string;
  at: number;
}

interface ApprovalRequest {
  approvalId: string;
  commandId: string;
  reason: string;
  risk: "low" | "medium" | "high";
  toolName?: string;
}

interface SavedSession extends RemoteWorkspaceSession {
  deviceId: string;
  projectId: string;
  providerId?: string;
  model?: string;
}

interface ClientSession extends RemoteWorkspaceSession {
  providerId?: string;
  model?: string;
}

interface MobilePreferences {
  runMode: RunMode;
  thinkingMode: ThinkingMode;
}

interface WorkAiProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  chatCompletionsPath: string;
  imageGenerationPath?: string;
  model: string;
  models: string[];
  defaultImageModel?: string;
  imageModels?: string[];
  apiKeyPreview?: string;
  updatedAt?: string;
}

interface WorkAiConfig {
  configured: boolean;
  id?: string;
  displayName?: string;
  baseUrl?: string;
  chatCompletionsPath?: string;
  imageGenerationPath?: string;
  model?: string;
  models?: string[];
  defaultImageModel?: string;
  imageModels?: string[];
  selectedProviderId?: string;
  providers?: WorkAiProvider[];
  apiKeyPreview?: string;
  updatedAt?: string;
}

interface WorkChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  images?: GeneratedImage[];
}

interface WorkChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId?: string;
  model?: string;
  imageModel?: string;
  thinkingMode: ThinkingMode;
  messages: WorkChatMessage[];
}

const EMPTY_SNAPSHOT: RemoteSnapshot = { devices: [], commands: [], events: [] };
const SNAPSHOT_CACHE_KEY = "remote.snapshot.v2";
const NAVIGATION_KEY = "remote.navigation.v2";
const SAVED_SESSIONS_KEY = "remote.mobile-sessions.v1";
const MOBILE_PREFERENCES_KEY = "remote.preferences.v1";
const WORK_MESSAGES_KEY = "work.messages.v1";
const WORK_SESSIONS_KEY = "work.sessions.v1";
const DEFAULT_PREFERENCES: MobilePreferences = { runMode: "workspace_write", thinkingMode: "balanced" };
const PREVIEW_MODE = import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview");
const PREVIEW_USER: User = { id: "preview", email: "preview@rcode.local", username: "preview", displayName: "林秋" };
const PREVIEW_EVENTS: LiveEvent[] = [{
  id: "preview-event",
  commandId: "preview-command",
  type: "completed",
  text: "已经检查完成。构建流程正常，当前改动集中在远程会话同步与手机端导航，没有发现新的 TypeScript 错误。",
  at: Date.now() - 42_000
}];
const PREVIEW_SNAPSHOT: RemoteSnapshot = {
  devices: [{
    id: "preview-device",
    name: "MacBook-Air.local",
    platform: "darwin",
    appVersion: "0.3.0",
    projectName: "Rcode",
    ready: true,
    online: true,
    lastSeenAt: Date.now(),
    workspace: {
      activeProjectId: "preview-project",
      defaultModel: "gpt-5.6-codex",
      models: ["gpt-5.6-codex", "gpt-5.4", "deepseek-v3"],
      projects: [{
        id: "preview-project",
        name: "Rcode",
        sessions: [
          { id: "preview-session", title: "安卓远程端重构", updatedAt: new Date().toISOString(), conversationId: "preview-conversation" },
          { id: "preview-session-2", title: "Cloudflare 服务部署", updatedAt: new Date(Date.now() - 3_600_000).toISOString() }
        ]
      }, {
        id: "preview-project-2",
        name: "个人网站",
        sessions: [{ id: "preview-session-3", title: "首页视觉优化", updatedAt: new Date(Date.now() - 7_200_000).toISOString() }]
      }]
    }
  }],
  commands: [{
    id: "preview-command",
    requestId: "preview-request",
    deviceId: "preview-device",
    action: "agent.run",
    status: "completed",
    summary: "检查项目有没有构建错误，并告诉我下一步建议",
    projectId: "preview-project",
    sessionId: "preview-session",
    model: "gpt-5.6-codex",
    createdAt: Date.now() - 64_000,
    updatedAt: Date.now() - 42_000
  }],
  events: []
};

const PREVIEW_WORK_SESSION: WorkChatSession = {
  id: "preview-work-session",
  title: "整理今天的工作计划",
  createdAt: Date.now() - 50_000,
  updatedAt: Date.now() - 45_000,
  providerId: "preview-provider",
  model: "gpt-5.4-mini",
  thinkingMode: "balanced",
  messages: [{
    id: "preview-work-user",
    role: "user",
    content: "帮我整理今天的工作计划",
    createdAt: Date.now() - 50_000
  }, {
    id: "preview-work-assistant",
    role: "assistant",
    content: "可以。建议按“修复阻塞问题 → 验证构建 → 整理提交 → 规划下一步”的顺序推进。",
    createdAt: Date.now() - 45_000,
    model: "gpt-5.4-mini",
    usage: { promptTokens: 120, completionTokens: 42, totalTokens: 162 }
  }]
};

function createWorkChatSession(thinking: ThinkingMode = "balanced"): WorkChatSession {
  const now = Date.now();
  return { id: createId("work-session"), title: "新对话", createdAt: now, updatedAt: now, thinkingMode: thinking, messages: [] };
}

function eventDescription(event: Record<string, unknown>) {
  if (event.type === "text_delta") return typeof event.delta === "string" ? event.delta : "";
  if (event.type === "workflow_state") return typeof event.label === "string" ? event.label : "电脑正在处理";
  if (event.type === "tool_call") return `正在调用 ${String(event.toolName || "工具")}`;
  if (event.type === "tool_result") return `${event.ok === false ? "工具执行失败" : "工具执行完成"}${event.toolName ? ` · ${String(event.toolName)}` : ""}`;
  if (event.type === "task_plan") return `任务计划 · ${Number(event.stepCount || 0)} 个步骤`;
  if (event.type === "diff_created") return `文件变更 · ${Number(event.fileCount || 0)} 个文件`;
  if (event.type === "billing_usage") return `本次用量 · ${Number(event.totalTokens || 0).toLocaleString()} tokens`;
  if (event.type === "context_snapshot") return `上下文 · ${Number(event.estimatedTokens || 0).toLocaleString()} tokens`;
  if (event.type === "learning_result") return Number(event.recordsSaved || 0) > 0 ? `已保存 ${Number(event.recordsSaved)} 条学习记录` : "自动学习检查完成";
  if (event.type === "permission_decision") return typeof event.reason === "string" ? event.reason : "权限检查完成";
  if (event.type === "completed") return typeof event.answer === "string" ? event.answer : "任务已完成";
  if (event.type === "stopped") return typeof event.message === "string" ? event.message : "已终止本次会话";
  if (event.type === "error") return typeof event.message === "string" ? event.message : "任务执行失败";
  if (event.type === "approval_required") return typeof event.reason === "string" ? event.reason : "需要你的批准";
  return "";
}

function shortTime(value: number | string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function relativeTime(value: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 20) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function connectionCopy(state: ConnectionState) {
  if (state === "online") return "在线";
  if (state === "connecting") return "连接中";
  if (state === "waiting") return "重连中";
  return "离线";
}

function commandStatusCopy(status: RemoteCommand["status"]) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "发送失败";
  if (status === "awaiting_approval") return "等待确认";
  if (status === "running") return "正在回复";
  return "已发送";
}

function serviceHost(url: string) {
  try { return new URL(url).host; } catch { return url; }
}

function mergeRemoteCommand(snapshot: RemoteSnapshot, command: RemoteCommand): RemoteSnapshot {
  return {
    ...snapshot,
    commands: [command, ...snapshot.commands.filter((item) => item.id !== command.id && item.requestId !== command.requestId)].slice(0, 100)
  };
}

function fallbackProjects(device?: RemoteDevice): RemoteWorkspaceProject[] {
  if (!device) return [];
  if (device.workspace?.projects.length) return device.workspace.projects;
  if (!device.projectName) return [];
  return [{ id: "active-project", name: device.projectName, sessions: [] }];
}

export function App() {
  const [booting, setBooting] = useState(!PREVIEW_MODE);
  const [user, setUser] = useState<User | undefined>(PREVIEW_MODE ? PREVIEW_USER : undefined);
  const [screen, setScreen] = useState<Screen>("work");
  const [snapshot, setSnapshot] = useState<RemoteSnapshot>(PREVIEW_MODE ? PREVIEW_SNAPSHOT : EMPTY_SNAPSHOT);
  const snapshotRef = useRef<RemoteSnapshot>(PREVIEW_MODE ? PREVIEW_SNAPSHOT : EMPTY_SNAPSHOT);
  const [selectedDeviceId, setSelectedDeviceId] = useState(PREVIEW_MODE ? "preview-device" : "");
  const [selectedProjectId, setSelectedProjectId] = useState(PREVIEW_MODE ? "preview-project" : "");
  const [selectedSessionId, setSelectedSessionId] = useState(PREVIEW_MODE ? "preview-session" : "");
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(PREVIEW_MODE ? "online" : "offline");
  const [events, setEvents] = useState<LiveEvent[]>(PREVIEW_MODE ? PREVIEW_EVENTS : []);
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [preferences, setPreferences] = useState<MobilePreferences>(DEFAULT_PREFERENCES);
  const [workConfig, setWorkConfig] = useState<WorkAiConfig>(PREVIEW_MODE ? {
    configured: true,
    id: "preview-provider",
    displayName: "MiMo API",
    baseUrl: "https://api.example.com/v1",
    chatCompletionsPath: "/chat/completions",
    imageGenerationPath: "/images/generations",
    model: "gpt-5.4-mini",
    models: ["gpt-5.4-mini", "mimo-v2.5-pro"],
    defaultImageModel: "gpt-image-2",
    imageModels: ["gpt-image-2"],
    selectedProviderId: "preview-provider",
    providers: [{
      id: "preview-provider",
      displayName: "MiMo API",
      baseUrl: "https://api.example.com/v1",
      chatCompletionsPath: "/chat/completions",
      imageGenerationPath: "/images/generations",
      model: "gpt-5.4-mini",
      models: ["gpt-5.4-mini", "mimo-v2.5-pro"],
      defaultImageModel: "gpt-image-2",
      imageModels: ["gpt-image-2"],
      apiKeyPreview: "••••demo"
    }],
    apiKeyPreview: "••••demo"
  } : { configured: false });
  const [workSessions, setWorkSessions] = useState<WorkChatSession[]>(PREVIEW_MODE ? [PREVIEW_WORK_SESSION] : []);
  const [activeWorkSessionId, setActiveWorkSessionId] = useState(PREVIEW_MODE ? PREVIEW_WORK_SESSION.id : "");
  const [workConfigLoading, setWorkConfigLoading] = useState(!PREVIEW_MODE);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [workPicker, setWorkPickerState] = useState<WorkPicker>(null);
  const [error, setError] = useState("");
  const controllerRef = useRef<RemoteController | undefined>(undefined);
  const drawerOpenRef = useRef(false);
  const modeMenuOpenRef = useRef(false);
  const workPickerRef = useRef<WorkPicker>(null);
  const activeScreenRef = useRef<Screen>("work");
  const nativeBackHandlerRef = useRef<() => void>(() => undefined);
  const codeAvailable = snapshot.devices.some((device) => device.online && device.ready);
  const activeWorkSession = workSessions.find((session) => session.id === activeWorkSessionId) || workSessions[0];
  const workMessages = activeWorkSession?.messages ?? [];

  const setDrawer = useCallback((open: boolean) => {
    drawerOpenRef.current = open;
    setDrawerOpen(open);
  }, []);

  const setModeMenu = useCallback((open: boolean) => {
    modeMenuOpenRef.current = open;
    setModeMenuOpen(open);
  }, []);

  const setWorkPicker = useCallback((picker: WorkPicker) => {
    workPickerRef.current = picker;
    setWorkPickerState(picker);
  }, []);

  const selectedDevice = snapshot.devices.find((device) => device.id === selectedDeviceId);
  const projects = useMemo(() => fallbackProjects(selectedDevice), [selectedDevice]);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const sessions = useMemo<ClientSession[]>(() => {
    if (!selectedDevice || !selectedProject) return [];
    const saved = savedSessions.filter((session) => session.deviceId === selectedDevice.id && session.projectId === selectedProject.id);
    const savedById = new Map(saved.map((session) => [session.id, session]));
    const remote = selectedProject.sessions.map((session) => ({ ...session, providerId: savedById.get(session.id)?.providerId, model: savedById.get(session.id)?.model }));
    const remoteIds = new Set(remote.map((session) => session.id));
    return [...remote, ...saved.filter((session) => !remoteIds.has(session.id))]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [savedSessions, selectedDevice, selectedProject]);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const sharedAiProviders = useMemo<WorkAiProvider[]>(() => {
    if (workConfig.providers?.length) return workConfig.providers;
    if (!workConfig.configured || !workConfig.baseUrl || !workConfig.model) return [];
    return [{
      id: workConfig.selectedProviderId || workConfig.id || "default",
      displayName: workConfig.displayName || serviceHost(workConfig.baseUrl),
      baseUrl: workConfig.baseUrl,
      chatCompletionsPath: workConfig.chatCompletionsPath || "/chat/completions",
      imageGenerationPath: workConfig.imageGenerationPath || "/images/generations",
      model: workConfig.model,
      models: workConfig.models?.length ? workConfig.models : [workConfig.model],
      defaultImageModel: workConfig.defaultImageModel,
      imageModels: workConfig.imageModels ?? []
    }];
  }, [workConfig]);
  const currentProviderId = selectedSession?.providerId || workConfig.selectedProviderId || sharedAiProviders[0]?.id || "";
  const currentProvider = sharedAiProviders.find((provider) => provider.id === currentProviderId) || sharedAiProviders[0];
  const models = currentProvider?.models?.length ? currentProvider.models : selectedDevice?.workspace?.models ?? [];
  const currentModel = selectedSession?.model && models.includes(selectedSession.model)
    ? selectedSession.model
    : currentProvider?.model || selectedDevice?.workspace?.defaultModel || models[0] || "Agent";

  const selectedCommands = useMemo(() => snapshot.commands.filter((command) =>
    command.deviceId === selectedDeviceId && command.projectId === selectedProjectId && command.sessionId === selectedSessionId
  ), [selectedDeviceId, selectedProjectId, selectedSessionId, snapshot.commands]);
  const selectedEvents = useMemo(() => {
    const ids = new Set(selectedCommands.map((command) => command.id));
    return events.filter((event) => ids.has(event.commandId));
  }, [events, selectedCommands]);
  const selectedApproval = approval && selectedCommands.some((command) => command.id === approval.commandId) ? approval : undefined;

  let activeScreen = screen;
  if ((activeScreen === "code" || activeScreen === "console") && (!selectedDevice || !selectedProject)) activeScreen = "work";
  if (activeScreen === "console" && !selectedSession) activeScreen = "code";
  activeScreenRef.current = activeScreen;

  const navigate = useCallback((next: Screen) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    activeScreenRef.current = next;
    setDrawer(false);
    setModeMenu(false);
    setWorkPicker(null);
    setScreen(next);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
  }, [setDrawer, setModeMenu, setWorkPicker]);

  const switchModeInDrawer = useCallback((next: "work" | "code") => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    activeScreenRef.current = next;
    setModeMenu(false);
    setWorkPicker(null);
    setScreen(next);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
  }, [setModeMenu, setWorkPicker]);

  const goBack = useCallback(() => {
    const current = activeScreenRef.current;
    if (workPickerRef.current) setWorkPicker(null);
    else if (modeMenuOpenRef.current) setModeMenu(false);
    else if (drawerOpenRef.current) setDrawer(false);
    else if (current === "console") navigate("code");
    else if (current === "code") navigate("work");
    else if (current === "settings") navigate("work");
    else if (current === "work" && Capacitor.isNativePlatform()) void CapacitorApp.minimizeApp();
  }, [navigate, setDrawer, setModeMenu, setWorkPicker]);

  nativeBackHandlerRef.current = goBack;

  const refreshWorkAiConfig = useCallback(async (showLoading = false) => {
    if (!user || PREVIEW_MODE) return;
    if (showLoading) setWorkConfigLoading(true);
    try {
      setWorkConfig(await request<WorkAiConfig>("/v1/work/ai-config"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取聊天 AI 配置");
    } finally {
      if (showLoading) setWorkConfigLoading(false);
    }
  }, [user]);

  const updateSavedSession = useCallback((details: SavedSession) => {
    setSavedSessions((current) => {
      const index = current.findIndex((item) => item.id === details.id && item.deviceId === details.deviceId && item.projectId === details.projectId);
      if (index < 0) return [details, ...current].slice(0, 200);
      const next = [...current];
      next[index] = { ...next[index], ...details };
      return next;
    });
  }, []);

  const mergeCommand = useCallback((command: RemoteCommand) => {
    setSnapshot((current) => {
      const next = mergeRemoteCommand(current, command);
      snapshotRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (PREVIEW_MODE) return;
    void (async () => {
      const token = await readToken();
      if (token) {
        const [cachedUser, cachedSnapshot, navigation, cachedSessions, cachedPreferences] = await Promise.all([
          readCachedUser(),
          readLocalState<RemoteSnapshot>(SNAPSHOT_CACHE_KEY, EMPTY_SNAPSHOT),
          readLocalState(NAVIGATION_KEY, { deviceId: "", projectId: "", sessionId: "" }),
          readLocalState<SavedSession[]>(SAVED_SESSIONS_KEY, []),
          readLocalState<MobilePreferences>(MOBILE_PREFERENCES_KEY, DEFAULT_PREFERENCES)
        ]);
        if (cachedUser) setUser(cachedUser);
        const offlineSnapshot = {
          ...cachedSnapshot,
          devices: cachedSnapshot.devices.map((device) => ({ ...device, online: false, ready: false }))
        };
        snapshotRef.current = offlineSnapshot;
        setSnapshot(offlineSnapshot);
        setSelectedDeviceId(navigation.deviceId);
        setSelectedProjectId(navigation.projectId);
        setSelectedSessionId(navigation.sessionId);
        setSavedSessions(cachedSessions);
        setPreferences(cachedPreferences);
        setEvents((cachedSnapshot.events ?? []).flatMap((item) => {
          const text = eventDescription(item.event);
          return text ? [{ id: item.id, commandId: item.commandId, type: item.type, text, at: item.createdAt }] : [];
        }));
        try {
          const session = await request<{ user: User }>("/v1/auth/me");
          setUser(session.user);
          await writeCachedUser(session.user);
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) {
            await writeToken();
            await writeCachedUser();
            setUser(undefined);
          } else if (!cachedUser) setError(reason instanceof Error ? reason.message : "无法恢复会话");
        }
      }
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    if (!user || PREVIEW_MODE) return;
    const controller = new RemoteController({
      onState: setConnection,
      onSnapshot: (next) => {
        snapshotRef.current = next;
        setSnapshot(next);
        const history = (next.events ?? []).flatMap((item) => {
          const text = eventDescription(item.event);
          return text ? [{ id: item.id, commandId: item.commandId, type: item.type, text, at: item.createdAt }] : [];
        });
        setEvents((current) => {
          const byId = new Map(current.map((item) => [item.id, item]));
          history.forEach((item) => byId.set(item.id, item));
          return [...byId.values()].sort((a, b) => a.at - b.at).slice(-500);
        });
      },
      onCommand: mergeCommand,
      onError: setError,
      onEvent: ({ commandId, event }) => {
        const text = eventDescription(event);
        if (text) setEvents((current) => {
          const type = String(event.type);
          const last = current[current.length - 1];
          if (type === "text_delta" && last?.type === "text_delta" && last.commandId === commandId) {
            return [...current.slice(0, -1), { ...last, text: `${last.text}${text}`.slice(-20_000), at: Date.now() }];
          }
          return [...current.slice(-499), { id: `${commandId}:${Date.now()}:${current.length}`, commandId, type, text, at: Date.now() }];
        });
        if (typeof event.conversationId === "string") {
          const command = snapshotRef.current.commands.find((item) => item.id === commandId);
          if (command?.projectId && command.sessionId) {
            const project = snapshotRef.current.devices.find((item) => item.id === command.deviceId)?.workspace?.projects.find((item) => item.id === command.projectId);
            const remoteSession = project?.sessions.find((item) => item.id === command.sessionId);
            updateSavedSession({
              deviceId: command.deviceId,
              projectId: command.projectId,
              id: command.sessionId,
              title: remoteSession?.title || command.summary?.slice(0, 36) || "新会话",
              updatedAt: new Date().toISOString(),
              conversationId: event.conversationId,
              model: command.model
            });
          }
        }
        if (event.type === "approval_required" && typeof event.approvalId === "string") {
          setApproval({
            approvalId: event.approvalId,
            commandId,
            reason: typeof event.reason === "string" ? event.reason : "电脑请求执行受保护操作",
            risk: event.risk === "high" || event.risk === "medium" ? event.risk : "low",
            toolName: typeof event.toolCall === "object" && event.toolCall && "name" in event.toolCall
              ? String((event.toolCall as { name?: unknown }).name || "") : undefined
          });
        } else if (["completed", "error", "permission_decision"].includes(String(event.type))) {
          setApproval((current) => current?.commandId === commandId ? undefined : current);
        }
      }
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = undefined;
    };
  }, [mergeCommand, updateSavedSession, user]);

  useEffect(() => {
    if (!user || PREVIEW_MODE) return;
    void writeLocalState(SNAPSHOT_CACHE_KEY, snapshot);
  }, [snapshot, user]);

  useEffect(() => {
    if (!user || PREVIEW_MODE) return;
    void writeLocalState(NAVIGATION_KEY, { deviceId: selectedDeviceId, projectId: selectedProjectId, sessionId: selectedSessionId });
  }, [selectedDeviceId, selectedProjectId, selectedSessionId, user]);

  useEffect(() => {
    if (user && !PREVIEW_MODE) void writeLocalState(SAVED_SESSIONS_KEY, savedSessions);
  }, [savedSessions, user]);

  useEffect(() => {
    if (user && !PREVIEW_MODE) void writeLocalState(MOBILE_PREFERENCES_KEY, preferences);
  }, [preferences, user]);

  useEffect(() => {
    if (!user || PREVIEW_MODE) return;
    void (async () => {
      const stored = await readLocalState<WorkChatSession[]>(`${WORK_SESSIONS_KEY}.${user.id}`, []);
      if (stored.length > 0) {
        const normalized = stored.slice(0, 60).map((session) => ({ ...session, thinkingMode: session.thinkingMode || "balanced", messages: session.messages.slice(-60) }));
        setWorkSessions(normalized);
        setActiveWorkSessionId(normalized[0]!.id);
      } else {
        const legacyMessages = await readLocalState<WorkChatMessage[]>(WORK_MESSAGES_KEY, []);
        const session = createWorkChatSession(preferences.thinkingMode);
        session.messages = legacyMessages.slice(-60);
        session.title = session.messages.find((message) => message.role === "user")?.content.slice(0, 36) || "新对话";
        session.updatedAt = session.messages.at(-1)?.createdAt || session.createdAt;
        setWorkSessions([session]);
        setActiveWorkSessionId(session.id);
      }
    })();
    void refreshWorkAiConfig(true);
  }, [refreshWorkAiConfig, user]);

  useEffect(() => {
    if (activeScreen === "work") void refreshWorkAiConfig(false);
  }, [activeScreen, refreshWorkAiConfig]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void refreshWorkAiConfig(false);
    }).then((handle) => {
      if (disposed) void handle.remove();
      else removeListener = () => handle.remove();
    });
    return () => { disposed = true; if (removeListener) void removeListener(); };
  }, [refreshWorkAiConfig]);

  useEffect(() => {
    if (user && !PREVIEW_MODE && workSessions.length > 0) void writeLocalState(`${WORK_SESSIONS_KEY}.${user.id}`, workSessions.slice(0, 60));
  }, [user, workSessions]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("backButton", () => nativeBackHandlerRef.current()).then((handle) => {
      if (disposed) void handle.remove();
      else removeListener = () => handle.remove();
    });
    return () => { disposed = true; if (removeListener) void removeListener(); };
  }, []);

  function sendCommand(action: "agent.run" | "agent.approve", payload: Record<string, unknown>) {
    try {
      const pending = controllerRef.current?.sendCommand(selectedDeviceId, action, payload);
      if (!pending) throw new Error("远程连接尚未就绪");
      mergeCommand(pending);
      setError("");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务发送失败");
      return false;
    }
  }

  function stopCommand(command: RemoteCommand) {
    try {
      const controller = controllerRef.current;
      if (!controller) throw new Error("远程连接尚未就绪");
      controller.stopCommand(selectedDeviceId, command.id, command.requestId);
      const now = Date.now();
      mergeCommand({ ...command, status: "failed", summary: "已终止", updatedAt: now });
      setEvents((current) => [...current.slice(-499), {
        id: `${command.id}:stopped:${now}`,
        commandId: command.id,
        type: "stopped",
        text: "已终止本次会话",
        at: now
      }]);
      setApproval((current) => current?.commandId === command.id ? undefined : current);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法终止当前会话");
    }
  }

  function createSessionForProject(project: RemoteWorkspaceProject) {
    if (!selectedDevice) return;
    const session: SavedSession = {
      deviceId: selectedDevice.id,
      projectId: project.id,
      id: createId("mobile-session"),
      title: "新会话",
      updatedAt: new Date().toISOString(),
      providerId: currentProvider?.id,
      model: currentProvider?.model || selectedDevice.workspace?.defaultModel || models[0]
    };
    updateSavedSession(session);
    setSelectedProjectId(project.id);
    setSelectedSessionId(session.id);
    navigate("console");
  }

  function newWorkSession() {
    const session = createWorkChatSession(preferences.thinkingMode);
    setWorkSessions((current) => [session, ...current].slice(0, 60));
    setActiveWorkSessionId(session.id);
    navigate("work");
  }

  function updateWorkSessionMessages(messages: WorkChatMessage[]) {
    if (!activeWorkSession) return;
    const firstPrompt = messages.find((message) => message.role === "user")?.content.trim();
    setWorkSessions((current) => current.map((session) => session.id === activeWorkSession.id ? {
      ...session,
      title: session.title === "新对话" && firstPrompt ? firstPrompt.slice(0, 36) : session.title,
      updatedAt: Date.now(),
      messages: messages.slice(-60)
    } : session));
  }

  function updateWorkSessionOptions(options: { providerId: string; model: string; imageModel?: string; thinkingMode: ThinkingMode }) {
    if (!activeWorkSession) return;
    setWorkSessions((current) => current.map((session) => session.id === activeWorkSession.id ? { ...session, ...options, updatedAt: Date.now() } : session));
  }

  function openCodeMode(keepDrawerOpen: boolean) {
    const device = snapshot.devices.find((item) => item.id === selectedDeviceId && item.online && item.ready)
      || snapshot.devices.find((item) => item.online && item.ready);
    if (!device) {
      setError("Code 模式需要电脑端使用同一账号在线");
      navigate("work");
      return;
    }
    setSelectedDeviceId(device.id);
    const availableProjects = fallbackProjects(device);
    const nextProject = availableProjects.find((project) => project.id === selectedProjectId)
      || availableProjects.find((project) => project.id === device.workspace?.activeProjectId)
      || availableProjects[0];
    if (!nextProject) {
      setError("电脑端还没有可用项目");
      navigate("work");
      return;
    }
    setSelectedProjectId(nextProject?.id || "");
    setSelectedSessionId("");
    if (keepDrawerOpen) switchModeInDrawer("code");
    else navigate("code");
  }

  async function logout() {
    try { await request("/v1/auth/logout", { method: "POST" }); } catch { /* local logout still continues */ }
    controllerRef.current?.stop();
    await writeToken();
    await writeCachedUser();
    setUser(undefined);
    setSnapshot(EMPTY_SNAPSHOT);
    snapshotRef.current = EMPTY_SNAPSHOT;
    setEvents([]);
    setApproval(undefined);
    setWorkConfig({ configured: false });
    setWorkSessions([]);
    setActiveWorkSessionId("");
    setScreen("work");
  }

  if (booting) return <Splash />;
  if (!user) return <AuthScreen onAuthenticated={(session) => setUser(session.user)} />;

  const title = activeScreen === "code" ? "Code"
      : activeScreen === "console" ? selectedSession?.title || "新会话"
        : activeScreen === "settings" ? "设置" : "聊天";
  const isRootScreen = activeScreen === "work" || activeScreen === "code" || activeScreen === "console" || activeScreen === "settings";
  const isModeRoot = activeScreen === "work" || activeScreen === "code";
  const recentWorkSessions = [...workSessions].filter((session) => session.messages.length > 0).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 12);

  return (
    <main className="appShell">
      <SideDrawer
        open={drawerOpen}
        user={user}
        active={activeScreen}
        codeAvailable={codeAvailable}
        activeWorkSessionId={activeWorkSession?.id || ""}
        activeCodeSessionId={selectedSessionId}
        sessions={recentWorkSessions}
        codeDevice={selectedDevice}
        codeProjects={projects}
        savedCodeSessions={savedSessions}
        codeCommands={snapshot.commands}
        onClose={() => setDrawer(false)}
        onNewWork={newWorkSession}
        onNavigate={navigate}
        onSwitchChat={() => switchModeInDrawer("work")}
        onOpenCode={() => openCodeMode(true)}
        onOpenSession={(session) => { setActiveWorkSessionId(session.id); navigate("work"); }}
        onNewCodeSession={createSessionForProject}
        onOpenCodeSession={(project, session) => { setSelectedProjectId(project.id); setSelectedSessionId(session.id); navigate("console"); }}
      />
      <header className="topBar">
        <div className="topBarSide">
          {isRootScreen ? <button className="iconButton" onClick={() => setDrawer(true)} aria-label="打开菜单"><Menu size={22} /></button> : <button className="iconButton" onClick={goBack} aria-label="返回"><ArrowLeft size={22} /></button>}
        </div>
        <div className="topBarTitle">{isModeRoot ? <button className="topModelButton" onClick={() => setModeMenu(!modeMenuOpen)} aria-haspopup="menu" aria-expanded={modeMenuOpen}><strong>{activeScreen === "work" ? "聊天" : "Code"}</strong><ChevronDown className={modeMenuOpen ? "open" : ""} size={14} /></button> : <strong>{title}</strong>}<span className={activeScreen === "work" ? (workConfig.configured ? "online" : "offline") : connection}>{activeScreen === "work" ? (activeWorkSession?.model || workConfig.model || (workConfig.configured ? "云端可用" : "待配置")) : activeScreen === "console" ? currentModel : connectionCopy(connection)}</span></div>
        <div className="topBarSide right">
          {activeScreen === "work" && <button className="iconButton" onClick={newWorkSession} aria-label="新建聊天"><SquarePen size={21} /></button>}
        </div>
      </header>

      {modeMenuOpen && <div className="modeSwitcherLayer">
        <button className="modeSwitcherScrim" aria-label="关闭模式菜单" onClick={() => setModeMenu(false)} />
        <div className="modeSwitcherMenu" role="menu" aria-label="切换模式">
          <button className={activeScreen === "work" ? "active" : ""} role="menuitem" onClick={() => navigate("work")}>
            <MessageCircle size={19} />
            <span><strong>聊天</strong><small>云端 AI · 随时可用</small></span>
            {activeScreen === "work" && <Check size={17} />}
          </button>
          <button className={activeScreen === "code" || activeScreen === "console" ? "active" : ""} role="menuitem" onClick={() => openCodeMode(false)} disabled={!codeAvailable}>
            <Code2 size={19} />
            <span><strong>Code</strong><small>{codeAvailable ? "电脑在线 · 项目模式" : "电脑离线 · 已锁定"}</small></span>
            {activeScreen === "code" || activeScreen === "console" ? <Check size={17} /> : !codeAvailable ? <LockKeyhole size={15} /> : null}
          </button>
        </div>
      </div>}

      {error && <button className="errorBanner" onClick={() => setError("")}><span>{error}</span><X size={16} /></button>}

      {activeScreen === "work" && <WorkScreen
        config={workConfig}
        loadingConfig={workConfigLoading}
        key={activeWorkSession?.id || "empty-work-session"}
        messages={workMessages}
        initialProviderId={activeWorkSession?.providerId}
        initialModel={activeWorkSession?.model}
        initialImageModel={activeWorkSession?.imageModel}
        initialThinkingMode={activeWorkSession?.thinkingMode || preferences.thinkingMode}
        onMessagesChange={updateWorkSessionMessages}
        onSessionOptionsChange={updateWorkSessionOptions}
        picker={workPicker}
        onPickerChange={setWorkPicker}
        onConfigure={() => navigate("settings")}
        onError={setError}
      />}

      {activeScreen === "code" && selectedDevice && selectedProject && <CodeHomeScreen device={selectedDevice} project={selectedProject} />}

      {activeScreen === "console" && selectedDevice && selectedProject && selectedSession && <ChatScreen
        device={selectedDevice}
        project={selectedProject}
        commands={selectedCommands}
        events={selectedEvents}
        approval={selectedApproval}
        models={models}
        model={currentModel}
        providers={sharedAiProviders}
        providerId={currentProvider?.id || currentProviderId}
        canSend={connection === "online" && selectedDevice.online && selectedDevice.ready}
        initialMode={preferences.runMode}
        initialThinkingMode={preferences.thinkingMode}
        onProviderChange={(providerId) => {
          const provider = sharedAiProviders.find((item) => item.id === providerId);
          if (provider) updateSavedSession({ deviceId: selectedDevice.id, projectId: selectedProject.id, ...selectedSession, providerId, model: provider.model });
        }}
        onModelChange={(model) => updateSavedSession({ deviceId: selectedDevice.id, projectId: selectedProject.id, ...selectedSession, providerId: currentProvider?.id, model })}
        onPreferencesChange={setPreferences}
        onSend={(prompt, mode, thinkingMode) => {
          const sent = sendCommand("agent.run", {
            prompt,
            mode,
            projectId: selectedProject.id,
            sessionId: selectedSession.id,
            conversationId: selectedSession.conversationId,
            providerId: currentProvider?.id,
            model: currentModel,
            thinkingMode
          });
          if (sent) updateSavedSession({
            deviceId: selectedDevice.id,
            projectId: selectedProject.id,
            ...selectedSession,
            title: selectedSession.title === "新会话" ? prompt.slice(0, 36) : selectedSession.title,
            updatedAt: new Date().toISOString(),
            providerId: currentProvider?.id,
            model: currentModel
          });
          return sent;
        }}
        onApproval={(allow, mode, thinkingMode) => {
          if (!selectedApproval) return;
          if (sendCommand("agent.approve", {
            approvalId: selectedApproval.approvalId,
            originCommandId: selectedApproval.commandId,
            allow,
            projectId: selectedProject.id,
            sessionId: selectedSession.id,
            providerId: currentProvider?.id,
            model: currentModel,
            mode,
            thinkingMode
          })) setApproval(undefined);
        }}
        onStop={stopCommand}
      />}

      {activeScreen === "settings" && <SettingsScreen
        user={user}
        apiBase={API_BASE}
        devices={snapshot.devices}
        preferences={preferences}
        workConfig={workConfig}
        onPreferencesChange={setPreferences}
        onWorkConfigChange={setWorkConfig}
        onLogout={() => void logout()}
      />}
    </main>
  );
}

function Splash() {
  return <main className="splash"><div className="splashMark">RC</div><LoaderCircle className="spin" size={20} /><p>正在恢复安全会话</p></main>;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: AuthResult) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body = mode === "login"
        ? { identifier: String(form.get("identifier") || ""), password: String(form.get("password") || "") }
        : { email: String(form.get("email") || ""), username: String(form.get("username") || ""), displayName: String(form.get("displayName") || ""), password: String(form.get("password") || "") };
      const result = await request<AuthResult>(`/v1/auth/${mode}`, { method: "POST", body: JSON.stringify(body) }, false);
      await writeToken(result.token);
      await writeCachedUser(result.user);
      onAuthenticated(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally { setBusy(false); }
  }

  return <main className="authScreen">
    <section className="authIntro"><div className="authWordmark"><span>RC</span><strong>Rcode</strong></div><p className="eyebrow">你的电脑，就在手边</p><h1>项目、会话、<br />工作都在继续。</h1><p className="authLead">像聊天一样管理电脑上的 Agent 工作，随时切换项目与模型。</p><div className="trustLine"><ShieldCheck size={17} /><span>账号隔离 · 敏感操作仍需审批</span></div></section>
    <form className="authForm" onSubmit={submit}>
      <div className="formHeading"><div><h2>{mode === "login" ? "登录 Rcode" : "创建账号"}</h2><p>{mode === "login" ? "连接你的电脑工作区" : "在手机与电脑之间建立统一身份"}</p></div><LockKeyhole size={21} /></div>
      {mode === "login" ? <label><span>邮箱或用户名</span><input name="identifier" autoCapitalize="none" autoComplete="username" required placeholder="name@example.com" /></label> : <div className="registerFields"><label><span>显示名称</span><input name="displayName" required placeholder="你的名字" /></label><label><span>用户名</span><input name="username" autoCapitalize="none" required placeholder="rcode_user" /></label><label><span>邮箱</span><input name="email" type="email" autoCapitalize="none" required placeholder="name@example.com" /></label></div>}
      <label><span>密码</span><input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : undefined} placeholder="至少 8 位，包含字母和数字" /></label>
      {error && <div className="formError">{error}</div>}
      <button className="primaryButton" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ChevronRight size={18} />}{busy ? "正在验证" : mode === "login" ? "进入工作区" : "创建并登录"}</button>
      <button type="button" className="textButton" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "还没有账号？创建账号" : "已有账号？返回登录"}</button>
    </form>
  </main>;
}

function CodeHomeScreen({ device, project }: { device: RemoteDevice; project: RemoteWorkspaceProject }) {
  return <section className="codeHomePage"><div className="codeHomeMark"><Folder size={30} fill="currentColor" /></div><p className="overline">CODE WORKSPACE</p><h1>{project.name}</h1><p>从左侧项目文件夹中选择会话，或点击文件夹右侧的加号创建新会话。</p><div className="codeHomeDevice"><span className={device.online ? "onlineDot active" : "onlineDot"} /><span>{device.name}</span><small>{device.online ? "电脑在线" : "电脑离线"}</small></div></section>;
}

function ChatScreen({ device, project, commands, events, approval, providers, providerId, models, model, canSend, initialMode, initialThinkingMode, onProviderChange, onModelChange, onPreferencesChange, onSend, onApproval, onStop }: { device: RemoteDevice; project: RemoteWorkspaceProject; commands: RemoteCommand[]; events: LiveEvent[]; approval?: ApprovalRequest; providers: WorkAiProvider[]; providerId: string; models: string[]; model: string; canSend: boolean; initialMode: RunMode; initialThinkingMode: ThinkingMode; onProviderChange: (providerId: string) => void; onModelChange: (model: string) => void; onPreferencesChange: (preferences: MobilePreferences) => void; onSend: (prompt: string, mode: RunMode, thinkingMode: ThinkingMode) => boolean; onApproval: (allow: boolean, mode: RunMode, thinkingMode: ThinkingMode) => void; onStop: (command: RemoteCommand) => void }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<RunMode>(initialMode);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(initialThinkingMode);
  const timelineRef = useRef<HTMLDivElement>(null);
  const runs = commands.filter((command) => command.action === "agent.run").sort((a, b) => a.createdAt - b.createdAt);
  const activeRun = [...runs].reverse().find((command) => ["queued", "running", "awaiting_approval"].includes(command.status));

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "auto" });
  }, [events.length, approval, commands.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || !canSend || activeRun) return;
    if (onSend(value, mode, thinkingMode)) setPrompt("");
  }

  function updateMode(next: RunMode) {
    setMode(next);
    onPreferencesChange({ runMode: next, thinkingMode });
  }

  function updateThinkingMode(next: ThinkingMode) {
    setThinkingMode(next);
    onPreferencesChange({ runMode: mode, thinkingMode: next });
  }

  return <section className="chatPage">
    <div className="chatContext"><span><i className={device.online ? "active" : ""} />{project.name}</span><div className="codeAiSelectors"><label><Cloud size={14} /><select aria-label="Code AI 接口" value={providerId} onChange={(event) => onProviderChange(event.target.value)} disabled={providers.length === 0}>{providers.length ? providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>) : <option>电脑默认</option>}</select><ChevronDown size={13} /></label><label><Bot size={14} /><select aria-label="Code 模型" value={model} onChange={(event) => onModelChange(event.target.value)} disabled={models.length === 0}>{models.length ? models.map((option) => <option key={option} value={option}>{option}</option>) : <option>{model}</option>}</select><ChevronDown size={13} /></label></div></div>
    <div className="chatTimeline" ref={timelineRef}>
      {runs.length === 0 ? <div className="chatWelcome"><div><Terminal size={28} /></div><p className="overline">{device.name} / {project.name}</p><h2>开始这个会话</h2><p>像在电脑端一样描述任务，执行过程、审批和结果会实时同步。</p><div className="suggestionChips">{["检查项目的构建错误", "总结当前代码改动", "规划下一步开发任务"].map((text, index) => <button key={text} onClick={() => setPrompt(text)}><span>0{index + 1}</span>{text}<ChevronRight size={15} /></button>)}</div></div> : runs.map((command) => {
        const runEvents = events.filter((event) => event.commandId === command.id);
        const completed = [...runEvents].reverse().find((event) => event.type === "completed");
        const failed = [...runEvents].reverse().find((event) => event.type === "error");
        const stopped = [...runEvents].reverse().find((event) => event.type === "stopped");
        const deltas = runEvents.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
        const assistantText = failed?.text || completed?.text || deltas;
        const trace = [...runEvents].reverse().find((event) => event.type === "workflow_state" || event.type === "tool_call");
        const runDetails = runEvents.filter((event) => ["task_plan", "tool_call", "tool_result", "diff_created", "billing_usage", "context_snapshot", "learning_result", "permission_decision"].includes(event.type)).slice(-5);
        const active = ["queued", "running", "awaiting_approval"].includes(command.status);
        return <div className="messageRun" key={command.id}>
          <div className="messageRow user"><div className="bubble">{command.summary || "远程任务"}</div></div>
          {runDetails.length > 0 && <div className="runTrace">{runDetails.map((event) => <div key={event.id}>{active && event === runDetails[runDetails.length - 1] ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}<span>{event.text}</span></div>)}</div>}
          {(assistantText || active || stopped) && <div className="messageRow assistant"><div className="assistantAvatar"><Bot size={17} /></div><div className={`bubble ${failed ? "failed" : ""}`}>{assistantText ? <p>{assistantText}</p> : stopped ? <p>{stopped.text}</p> : <div className="typing"><i /><i /><i /></div>}<footer>{active ? <><LoaderCircle className="spin" size={12} />{trace?.text || commandStatusCopy(command.status)}</> : stopped ? <><Square size={11} fill="currentColor" />已终止 · {command.model || model}</> : <><Check size={12} />{commandStatusCopy(command.status)} · {command.model || model}</>}</footer></div></div>}
        </div>;
      })}
      {approval && <div className="approvalCard"><div className="approvalHeading"><ShieldCheck size={20} /><div><strong>电脑请求授权</strong><span>{approval.risk === "high" ? "高风险操作" : approval.risk === "medium" ? "需要注意" : "低风险操作"}</span></div></div><p>{approval.reason}</p>{approval.toolName && <code>{approval.toolName}</code>}<div className="approvalActions"><button onClick={() => onApproval(false, mode, thinkingMode)}><X size={16} />拒绝</button><button className="approve" onClick={() => onApproval(true, mode, thinkingMode)}><Check size={16} />允许一次</button></div></div>}
    </div>
    <form className="composer" onSubmit={submit}>
      <div className="composerTools">
        <label className="compactSelect"><ShieldCheck size={13} /><select aria-label="权限模式" value={mode} onChange={(event) => updateMode(event.target.value as RunMode)}>{RUN_MODES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><ChevronDown size={12} /></label>
        <label className="compactSelect"><Brain size={13} /><select aria-label="思考强度" value={thinkingMode} onChange={(event) => updateThinkingMode(event.target.value as ThinkingMode)}>{THINKING_MODES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><ChevronDown size={12} /></label>
        <span>{activeRun ? "正在执行 · 可随时终止" : canSend ? "电脑在线" : "电脑不可用"}</span>
      </div>
      <div className="composerRow"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={1} placeholder={activeRun ? "电脑正在执行任务" : canSend ? "发送消息" : "等待电脑上线"} disabled={!canSend || Boolean(activeRun)} /><button type={activeRun ? "button" : "submit"} className={activeRun ? "codeStopButton" : undefined} aria-label={activeRun ? "终止会话" : "发送"} onClick={activeRun ? () => onStop(activeRun) : undefined} disabled={!activeRun && (!canSend || !prompt.trim())}>{activeRun ? <Square size={15} fill="currentColor" /> : <Send size={19} />}</button></div>
    </form>
  </section>;
}

function EmptyState({ icon, title, copy, action, onAction }: { icon: React.ReactNode; title: string; copy: string; action?: string; onAction?: () => void }) {
  return <div className="emptyState"><div className="emptyIcon">{icon}</div><h2>{title}</h2><p>{copy}</p>{action && onAction && <button className="secondaryButton" onClick={onAction}>{action}</button>}</div>;
}

function WorkScreen({ config, loadingConfig, messages, initialProviderId, initialModel, initialImageModel, initialThinkingMode, onMessagesChange, onSessionOptionsChange, picker, onPickerChange, onConfigure, onError }: { config: WorkAiConfig; loadingConfig: boolean; messages: WorkChatMessage[]; initialProviderId?: string; initialModel?: string; initialImageModel?: string; initialThinkingMode: ThinkingMode; onMessagesChange: (messages: WorkChatMessage[]) => void; onSessionOptionsChange: (options: { providerId: string; model: string; imageModel?: string; thinkingMode: ThinkingMode }) => void; picker: WorkPicker; onPickerChange: (picker: WorkPicker) => void; onConfigure: () => void; onError: (message: string) => void }) {
  const providers = useMemo<WorkAiProvider[]>(() => {
    if (config.providers?.length) return config.providers;
    if (!config.configured || !config.baseUrl || !config.model) return [];
    return [{
      id: config.selectedProviderId || config.id || "default",
      displayName: config.displayName || serviceHost(config.baseUrl),
      baseUrl: config.baseUrl,
      chatCompletionsPath: config.chatCompletionsPath || "/chat/completions",
      imageGenerationPath: config.imageGenerationPath || "/images/generations",
      model: config.model,
      models: config.models?.length ? config.models : [config.model],
      defaultImageModel: config.defaultImageModel,
      imageModels: config.imageModels ?? [],
      apiKeyPreview: config.apiKeyPreview,
      updatedAt: config.updatedAt
    }];
  }, [config]);
  const initialProvider = providers.find((provider) => provider.id === initialProviderId) || providers.find((provider) => provider.id === config.selectedProviderId) || providers[0];
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [providerId, setProviderId] = useState(initialProvider?.id || "");
  const [model, setModel] = useState(initialProvider?.models.includes(initialModel || "") ? initialModel! : initialProvider?.model || config.model || "");
  const [imageModel, setImageModel] = useState(initialProvider?.imageModels?.includes(initialImageModel || "") ? initialImageModel! : initialProvider?.defaultImageModel || initialProvider?.imageModels?.[0] || "");
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(initialThinkingMode);
  const [previewImage, setPreviewImage] = useState<GeneratedImage | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const selectedProvider = providers.find((provider) => provider.id === providerId) || providers[0];
  const availableTextModels = selectedProvider?.models?.length ? selectedProvider.models : selectedProvider?.model ? [selectedProvider.model] : [];
  const availableModels = availableTextModels;
  const activeModel = model;
  const imageMode = false;

  useEffect(() => {
    const nextProvider = providers.find((provider) => provider.id === providerId)
      || providers.find((provider) => provider.id === config.selectedProviderId)
      || providers[0];
    if (!nextProvider) {
      setProviderId("");
      setModel("");
      setImageModel("");
      return;
    }
    if (nextProvider.id !== providerId) setProviderId(nextProvider.id);
    setModel((current) => nextProvider.models.includes(current) ? current : nextProvider.model);
    setImageModel((current) => nextProvider.imageModels?.includes(current) ? current : nextProvider.defaultImageModel || nextProvider.imageModels?.[0] || "");
  }, [config.selectedProviderId, providerId, providers]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "auto" });
  }, [messages.length, messages[messages.length - 1]?.content.length, messages[messages.length - 1]?.images?.length, busy]);

  useEffect(() => {
    if (!previewImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewImage]);

  function selectProvider(nextProviderId: string) {
    const nextProvider = providers.find((provider) => provider.id === nextProviderId);
    setProviderId(nextProviderId);
    if (nextProvider) {
      setModel(nextProvider.model);
      const nextImageModel = nextProvider.defaultImageModel || nextProvider.imageModels?.[0] || "";
      setImageModel(nextImageModel);
      onSessionOptionsChange({ providerId: nextProvider.id, model: nextProvider.model, imageModel: nextImageModel, thinkingMode });
    }
  }

  function selectModel(nextModel: string) {
    setModel(nextModel);
    if (selectedProvider) onSessionOptionsChange({
      providerId: selectedProvider.id,
      model: nextModel,
      imageModel,
      thinkingMode
    });
  }

  function selectThinkingMode(nextMode: ThinkingMode) {
    setThinkingMode(nextMode);
    if (selectedProvider && model) onSessionOptionsChange({ providerId: selectedProvider.id, model, imageModel, thinkingMode: nextMode });
  }

  function openConfiguration() {
    onPickerChange(null);
    onConfigure();
  }

  function stopResponse() {
    streamAbortRef.current?.abort();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = prompt.trim();
    if (!content || busy || !config.configured || !selectedProvider || !activeModel) return;
    const configuredImageModels = [...new Set([selectedProvider.defaultImageModel, ...(selectedProvider.imageModels ?? [])].filter((candidate): candidate is string => Boolean(candidate)))];
    const requestedImage = requestedImageModel(content, configuredImageModels);
    if (requestedImage.reference && !requestedImage.model) {
      onError(`图片模型“${requestedImage.reference}”未在当前接口配置`);
      return;
    }
    const requestImageModel = requestedImage.model || imageModel;
    const userMessage: WorkChatMessage = { id: createId("work-user"), role: "user", content, createdAt: Date.now() };
    const nextMessages = [...messages, userMessage].slice(-60);
    onSessionOptionsChange({ providerId: selectedProvider.id, model, imageModel, thinkingMode });
    let assistantMessage: WorkChatMessage = {
      id: createId("work-assistant"),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: activeModel
    };
    const publish = () => onMessagesChange([...nextMessages, assistantMessage].slice(-60));
    publish();
    setPrompt("");
    setBusy(true);
    onError("");
    const streamController = new AbortController();
    streamAbortRef.current = streamController;
    try {
      await streamWorkChat({
        providerId: selectedProvider.id,
        model,
        imageModel: requestImageModel,
        autoImage: true,
        thinkingMode,
        messages: nextMessages.slice(-20).map((message) => ({ role: message.role, content: message.content }))
      }, (streamEvent) => {
        if (streamEvent.type === "delta") {
          assistantMessage = { ...assistantMessage, content: assistantMessage.content + streamEvent.delta };
          publish();
        } else if (streamEvent.type === "image") {
          assistantMessage = {
            ...assistantMessage,
            content: streamEvent.images[0]?.revisedPrompt || "图片已生成",
            model: streamEvent.model || requestImageModel,
            images: streamEvent.images
          };
          publish();
        } else if (streamEvent.type === "done") {
          assistantMessage = { ...assistantMessage, model: streamEvent.model || model, usage: streamEvent.usage };
          publish();
        }
      }, streamController.signal);
      if (!assistantMessage.content.trim() && !assistantMessage.images?.length) throw new Error("AI 服务未返回内容");
    } catch (reason) {
      if (reason instanceof Error && reason.name === "AbortError") {
        if (!assistantMessage.content.trim()) onMessagesChange(nextMessages);
        onError("");
        return;
      }
      if (!assistantMessage.content) onMessagesChange(nextMessages);
      onError(reason instanceof Error ? reason.message : "聊天请求失败");
    } finally {
      if (streamAbortRef.current === streamController) streamAbortRef.current = null;
      setBusy(false);
    }
  }

  return <section className="workPage">
    <div className="workTimeline" ref={timelineRef}>
      {!config.configured ? <EmptyState icon={loadingConfig ? <LoaderCircle className="spin" size={28} /> : <KeyRound size={28} />} title={loadingConfig ? "正在读取聊天配置" : "配置云端 AI"} copy="保存 OpenAI 兼容接口后，即使电脑不在线也可以继续聊天。" action={loadingConfig ? undefined : "前往设置"} onAction={loadingConfig ? undefined : onConfigure} />
        : messages.length === 0 ? <div className="workWelcome"><div><span>RC</span></div><h1>有什么可以帮忙的？</h1><p>选择接口和模型后，回复会实时显示。</p><div className="suggestionChips">{["整理今天的工作计划", "总结一段文字", "帮我分析一个问题"].map((text, index) => <button key={text} onClick={() => setPrompt(text)}><span>0{index + 1}</span>{text}<ChevronRight size={15} /></button>)}</div></div>
          : <div className="workMessages">{messages.map((message, index) => {
            const streaming = busy && message.role === "assistant" && index === messages.length - 1;
            return <div className={`workMessage ${message.role}`} key={message.id}><div className="bubble">{message.images?.length ? <div className="workImageGrid">{message.images.map((generated) => <button type="button" key={generated.id} aria-label={`打开图片 ${generated.name}`} onClick={() => setPreviewImage(generated)}><img src={generated.dataUrl || generated.url} alt={generated.revisedPrompt || generated.name || "AI 生成图片"} loading="lazy" /></button>)}</div> : null}{message.content ? <p>{message.content}</p> : streaming ? <div className="typing"><i /><i /><i /></div> : null}{message.role === "assistant" && <footer>{streaming ? <LoaderCircle className="spin" size={11} /> : message.images?.length ? <Image size={11} /> : <Cloud size={11} />}{streaming ? "正在处理请求" : message.model || model}{message.usage?.totalTokens ? ` · ${message.usage.totalTokens.toLocaleString()} tokens` : ""}</footer>}</div></div>;
          })}</div>}
    </div>
    <form className="workComposer" onSubmit={submit}>
      <div className="workComposerTools">
        <div className="workChatControls">
          <button type="button" className="compactSelect workUnifiedModelButton" aria-label="选择接口或模型" aria-expanded={picker === "provider" || picker === "model"} onClick={() => onPickerChange(picker === "provider" || picker === "model" ? null : "provider")} disabled={!config.configured || providers.length === 0}><Bot size={13} /><span>{activeModel || "选择模型"}</span><ChevronDown size={11} /></button>
          <button type="button" className="compactSelect workThinkingButton" aria-label="选择思考强度" aria-expanded={picker === "thinking"} onClick={() => onPickerChange("thinking")} disabled={!config.configured}><Brain size={13} /><span>{THINKING_MODES.find((option) => option.id === thinkingMode)?.label}</span><ChevronDown size={11} /></button>
        </div>
      </div>
      <div className="workComposerShell">
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={1} placeholder={!config.configured ? "请先配置聊天 AI" : "发送消息"} disabled={!config.configured || busy} />
        <button type={busy ? "button" : "submit"} className={`workComposerSend ${busy ? "workStopButton" : ""}`} aria-label={busy ? "停止生成" : "发送消息"} onClick={busy ? stopResponse : undefined} disabled={!busy && (!config.configured || !prompt.trim() || !selectedProvider || !activeModel)}>{busy ? <Square size={15} fill="currentColor" /> : <Send size={18} />}</button>
      </div>
      <small>{busy ? "点击停止按钮可打断本次回复" : "图片需求会自动调用当前接口的生图模型。"}</small>
    </form>
    {picker && <div className="workPickerLayer">
      <button type="button" className="workPickerScrim" aria-label="关闭选择面板" onClick={() => onPickerChange(null)} />
      <div className="workPickerSheet" role="dialog" aria-modal="true" aria-label={picker === "thinking" ? "选择思考强度" : "接口与模型设置"}>
        <div className="workPickerHandle" />
        <header><div><h2>{picker === "thinking" ? "思考强度" : "接口与模型"}</h2><p>{picker === "thinking" ? "按任务复杂度选择本次对话的推理投入" : `${selectedProvider?.displayName || "当前接口"} · ${activeModel || "未选择模型"}`}</p></div><button type="button" aria-label="关闭" onClick={() => onPickerChange(null)}><X size={18} /></button></header>
        {picker !== "thinking" && <div className="workPickerTabs" role="tablist" aria-label="接口与模型"><button type="button" className={picker === "provider" ? "active" : ""} role="tab" aria-selected={picker === "provider"} onClick={() => onPickerChange("provider")}><Cloud size={15} />接口</button><button type="button" className={picker === "model" ? "active" : ""} role="tab" aria-selected={picker === "model"} onClick={() => onPickerChange("model")}><Bot size={15} />模型</button></div>}
        <div className="workPickerList">{picker === "provider" ? providers.map((provider) => <button type="button" className={provider.id === selectedProvider?.id ? "selected" : ""} key={provider.id} onClick={() => { selectProvider(provider.id); onPickerChange("model"); }}><span className="workPickerIcon"><Cloud size={18} /></span><span className="workPickerCopy"><strong>{provider.displayName}</strong><small>{serviceHost(provider.baseUrl)} · {provider.models.length} 个文本模型 · {provider.imageModels?.length || 0} 个图片模型</small></span><span className="workPickerCheck">{provider.id === selectedProvider?.id && <Check size={16} />}</span></button>) : picker === "model" ? availableModels.map((option) => <button type="button" className={option === activeModel ? "selected" : ""} key={option} onClick={() => { selectModel(option); onPickerChange(null); }}><span className="workPickerIcon"><Bot size={18} /></span><span className="workPickerCopy"><strong>{option}</strong><small>{selectedProvider?.displayName || "当前接口"}</small></span><span className="workPickerCheck">{option === activeModel && <Check size={16} />}</span></button>) : THINKING_MODES.map((option) => <button type="button" className={option.id === thinkingMode ? "selected" : ""} key={option.id} onClick={() => { selectThinkingMode(option.id); onPickerChange(null); }}><span className="workPickerIcon"><Brain size={18} /></span><span className="workPickerCopy"><strong>{option.label}</strong><small>{option.description}</small></span><span className="workPickerCheck">{option.id === thinkingMode && <Check size={16} />}</span></button>)}</div>
        {picker !== "thinking" && <button type="button" className="workPickerManage" onClick={openConfiguration}><Settings size={17} /><span>管理接口与模型</span><ChevronRight size={15} /></button>}
      </div>
    </div>}
    {previewImage && <div className="workImagePreview" role="dialog" aria-modal="true" aria-label={`查看图片 ${previewImage.name}`} onClick={() => setPreviewImage(null)}><div className="workImagePreviewDialog" onClick={(event) => event.stopPropagation()}><header><div><strong>{previewImage.name}</strong><small>{previewImage.mimeType}</small></div><button type="button" aria-label="关闭图片预览" onClick={() => setPreviewImage(null)}><X size={20} /></button></header><div><img src={previewImage.dataUrl || previewImage.url} alt={previewImage.revisedPrompt || previewImage.name} /></div></div></div>}
  </section>;
}

function SettingsScreen({ user, apiBase, devices, preferences, workConfig, onPreferencesChange, onWorkConfigChange, onLogout }: { user: User; apiBase: string; devices: RemoteDevice[]; preferences: MobilePreferences; workConfig: WorkAiConfig; onPreferencesChange: (preferences: MobilePreferences) => void; onWorkConfigChange: (config: WorkAiConfig) => void; onLogout: () => void }) {
  const models = [...new Set(devices.flatMap((device) => device.workspace?.models ?? []))];
  const online = devices.filter((device) => device.online).length;
  return <section className="rootPage settingsPage">
    <div className="profileHeader"><div className="profileAvatar">{user.displayName.slice(0, 1).toUpperCase()}</div><div><p className="overline">RCODE ACCOUNT</p><h1>{user.displayName}</h1><span>@{user.username}</span></div></div>

    <WorkAiSettings config={workConfig} onChange={onWorkConfigChange} />

    <section className="settingsSection"><div className="settingsHeading"><span>默认运行方式</span><small>新会话自动使用</small></div><div className="settingControls">
      <label><ShieldCheck size={17} /><span><strong>权限模式</strong><small>与电脑端权限模式一致</small></span><select value={preferences.runMode} onChange={(event) => onPreferencesChange({ ...preferences, runMode: event.target.value as RunMode })}>{RUN_MODES.map((option) => <option key={option.id} value={option.id}>{option.short}</option>)}</select><ChevronDown size={13} /></label>
      <label><Brain size={17} /><span><strong>思考强度</strong><small>控制响应速度与推理深度</small></span><select value={preferences.thinkingMode} onChange={(event) => onPreferencesChange({ ...preferences, thinkingMode: event.target.value as ThinkingMode })}>{THINKING_MODES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><ChevronDown size={13} /></label>
    </div></section>

    <section className="settingsSection"><div className="settingsHeading"><span>工作能力</span><small>与电脑端同步</small></div><div className="capabilityGrid">
      <div><LayoutGrid size={18} /><strong>{devices.reduce((total, device) => total + (device.workspace?.projects.length ?? 0), 0)}</strong><span>项目</span></div>
      <div><MessageCircle size={18} /><strong>{devices.reduce((total, device) => total + (device.workspace?.projects.reduce((count, project) => count + project.sessions.length, 0) ?? 0), 0)}</strong><span>会话</span></div>
      <div><Cpu size={18} /><strong>{models.length}</strong><span>模型</span></div>
    </div><div className="featureRows">
      <div><Cloud size={18} /><span><strong>聊天模式</strong><small>电脑离线时由云端 AI 继续对话</small></span><Check size={16} /></div>
      <div><Terminal size={18} /><span><strong>Code 模式</strong><small>电脑同时在线时使用项目和工具</small></span>{online > 0 ? <Check size={16} /> : <LockKeyhole size={16} />}</div>
      <div><Wrench size={18} /><span><strong>工具与审批</strong><small>实时进度、权限请求与远程确认</small></span><Check size={16} /></div>
      <div><Brain size={18} /><span><strong>模型与思考</strong><small>会话级模型和思考强度切换</small></span><Check size={16} /></div>
    </div></section>

    <section className="settingsSection"><div className="settingsHeading"><span>连接与账号</span><small>{online}/{devices.length} 台电脑在线</small></div><div className="settingsList"><div><CircleUserRound size={19} /><span><strong>{user.email}</strong><small>账号与会话身份</small></span></div><div><Smartphone size={19} /><span><strong>Android 客户端</strong><small>Rcode Mobile 0.9.0</small></span></div><div><LockKeyhole size={19} /><span><strong>{serviceHost(apiBase)}</strong><small>端到端远程服务</small></span></div></div></section>
    <div className="accountTrust"><ShieldCheck size={19} /><p>本机项目路径不会上传。移动端只接收电脑公开的工作区信息，受保护操作继续走审批流程。</p></div>
    <button className="logoutButton" onClick={onLogout}><LogOut size={17} />退出登录</button>
  </section>;
}

function WorkAiSettings({ config, onChange }: { config: WorkAiConfig; onChange: (config: WorkAiConfig) => void }) {
  const providers = config.providers?.length ? config.providers : config.configured && config.baseUrl && config.model ? [{
    id: config.selectedProviderId || config.id || "default",
    displayName: config.displayName || serviceHost(config.baseUrl),
    baseUrl: config.baseUrl,
    chatCompletionsPath: config.chatCompletionsPath || "/chat/completions",
    imageGenerationPath: config.imageGenerationPath || "/images/generations",
    model: config.model,
    models: config.models?.length ? config.models : [config.model],
    defaultImageModel: config.defaultImageModel,
    imageModels: config.imageModels ?? [],
    apiKeyPreview: config.apiKeyPreview
  }] : [];
  const currentProvider = providers.find((provider) => provider.id === config.selectedProviderId) || providers[0];
  const [open, setOpen] = useState(false);

  function closeManager() {
    setOpen(false);
  }

  return <section className="settingsSection workAiSettings"><div className="settingsHeading"><span>聊天 AI</span><small>{providers.length} 个接口</small></div>
    <button type="button" className="workAiEntry" onClick={() => setOpen(true)}><span className="workAiEntryIcon"><Cloud size={20} /></span><span><strong>{currentProvider?.displayName || "等待电脑端配置"}</strong><small>{currentProvider ? `${currentProvider.models.length} 个文本 · ${currentProvider.imageModels?.length || 0} 个图片模型 · ${serviceHost(currentProvider.baseUrl)}` : "请在电脑端 AI 接口中添加"}</small></span><ChevronRight size={18} /></button>
    <div className="workAiSecurity"><LockKeyhole size={15} /><span>与电脑端共用同一套接口；配置变更会自动同步，密钥仅在服务器端加密使用。</span></div>
    {open && <div className="workAiManagerLayer"><button type="button" className="workPickerScrim" aria-label="关闭接口管理" onClick={closeManager} /><section className="workAiManager" role="dialog" aria-modal="true" aria-label="AI 接口列表"><header><div><p className="overline">SHARED AI</p><h2>接口列表</h2><span>与电脑端 AI 接口共用同一套配置</span></div><button type="button" onClick={closeManager} aria-label="关闭"><X size={19} /></button></header>
      <div className="providerManagerList sharedProviderList">{providers.map((provider) => <div className={provider.id === config.selectedProviderId ? "selected" : ""} key={provider.id}><button type="button" onClick={() => onChange({ ...config, selectedProviderId: provider.id, ...provider })}><span className="workPickerIcon"><Cloud size={18} /></span><span><strong>{provider.displayName}</strong><small>{provider.models.length} 个文本 · {provider.imageModels?.length || 0} 个图片模型 · {serviceHost(provider.baseUrl)}</small></span>{provider.id === config.selectedProviderId && <Check size={16} />}</button></div>)}{providers.length === 0 && <div className="managerEmpty"><KeyRound size={25} /><strong>电脑端还没有接口</strong><span>请在电脑端「AI 接口」中添加，保存后会自动同步到这里。</span></div>}</div>
    </section></div>}
  </section>;
}

function SideDrawer({ open, user, active, codeAvailable, activeWorkSessionId, activeCodeSessionId, sessions, codeDevice, codeProjects, savedCodeSessions, codeCommands, onClose, onNewWork, onNavigate, onSwitchChat, onOpenCode, onOpenSession, onNewCodeSession, onOpenCodeSession }: { open: boolean; user: User; active: Screen; codeAvailable: boolean; activeWorkSessionId: string; activeCodeSessionId: string; sessions: WorkChatSession[]; codeDevice?: RemoteDevice; codeProjects: RemoteWorkspaceProject[]; savedCodeSessions: SavedSession[]; codeCommands: RemoteCommand[]; onClose: () => void; onNewWork: () => void; onNavigate: (screen: Screen) => void; onSwitchChat: () => void; onOpenCode: () => void; onOpenSession: (session: WorkChatSession) => void; onNewCodeSession: (project: RemoteWorkspaceProject) => void; onOpenCodeSession: (project: RemoteWorkspaceProject, session: ClientSession) => void }) {
  const [collapsedCodeFolders, setCollapsedCodeFolders] = useState<string[]>([]);
  const codeMode = active === "code" || active === "console";

  function projectSessions(project: RemoteWorkspaceProject): ClientSession[] {
    if (!codeDevice) return [];
    const saved = savedCodeSessions.filter((session) => session.deviceId === codeDevice.id && session.projectId === project.id);
    const savedById = new Map(saved.map((session) => [session.id, session]));
    const remote = project.sessions.map((session) => ({ ...session, providerId: savedById.get(session.id)?.providerId, model: savedById.get(session.id)?.model }));
    const remoteIds = new Set(remote.map((session) => session.id));
    return [...remote, ...saved.filter((session) => !remoteIds.has(session.id))]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  function toggleCodeFolder(projectId: string) {
    setCollapsedCodeFolders((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]);
  }

  return <div className={`drawerLayer ${open ? "open" : ""}`} aria-hidden={!open}>
    <button className="drawerScrim" aria-label="关闭菜单" onClick={onClose} tabIndex={open ? 0 : -1} />
    <aside className="sideDrawer" aria-label="对话与模式">
      <header><button className={`drawerProfileCard ${active === "settings" ? "active" : ""}`} aria-label={`打开 ${user.displayName} 的个人设置`} onClick={() => onNavigate("settings")}><span className="drawerProfileAvatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span className="drawerProfileCopy"><strong>{user.displayName}</strong><small>@{user.username}</small><small>{user.email}</small></span><ChevronRight size={15} /></button><button aria-label="收起菜单" onClick={onClose}><PanelLeftClose size={20} /></button></header>
      {codeMode ? <div className="drawerCodeDevice"><span className={codeDevice?.online ? "onlineDot active" : "onlineDot"} /><span>{codeDevice?.name || "Code 工作区"}</span><small>{codeDevice?.online ? "在线" : "离线"}</small></div> : <button className="newChatButton" onClick={onNewWork}><SquarePen size={18} /><span>新对话</span></button>}
      <nav className="modeNavigation">
        <button className={active === "work" ? "active" : ""} onClick={onSwitchChat}><MessageCircle size={18} /><span><strong>聊天</strong><small>云端 AI · 随时可用</small></span></button>
        <button className={codeMode ? "active" : ""} onClick={onOpenCode} disabled={!codeAvailable}><Code2 size={18} /><span><strong>Code</strong><small>{codeAvailable ? "电脑在线 · 项目模式" : "电脑离线 · 已锁定"}</small></span>{!codeAvailable && <LockKeyhole size={14} />}</button>
      </nav>
      <section className={`drawerHistory ${codeMode ? "drawerCodeHistory" : ""}`}><p>{codeMode ? "项目与会话" : "最近对话"}</p>{codeMode ? <div className="drawerFolderTree">{codeProjects.map((project) => {
        const folderSessions = projectSessions(project);
        const expanded = !collapsedCodeFolders.includes(project.id);
        return <div className={`drawerFolder ${expanded ? "expanded" : ""}`} key={project.id}><div className="drawerFolderHeader"><button type="button" aria-expanded={expanded} onClick={() => toggleCodeFolder(project.id)}><Folder size={17} fill="currentColor" /><span><strong>{project.name}</strong><small>{folderSessions.length} 个会话</small></span><ChevronDown size={14} /></button><button type="button" aria-label={`在 ${project.name} 中新建会话`} onClick={() => onNewCodeSession(project)}><Plus size={15} /></button></div>{expanded && <div className="drawerFolderSessions">{folderSessions.map((session) => {
          const latest = codeCommands.find((command) => command.deviceId === codeDevice?.id && command.projectId === project.id && command.sessionId === session.id);
          const running = latest && ["running", "queued", "awaiting_approval"].includes(latest.status);
          return <button type="button" className={session.id === activeCodeSessionId ? "selected" : ""} key={session.id} onClick={() => onOpenCodeSession(project, session)}><MessageCircle size={15} /><span><strong>{session.title}</strong><small>{latest?.summary || session.model || "Code 会话"} · {shortTime(session.updatedAt)}</small></span>{running ? <i /> : null}</button>;
        })}{folderSessions.length === 0 && <button type="button" className="drawerFolderEmpty" onClick={() => onNewCodeSession(project)}><Plus size={14} /><span>新建会话</span></button>}</div>}</div>;
      })}{codeProjects.length === 0 && <span className="emptyHistory">还没有可用项目</span>}</div> : <>{sessions.map((session) => <button className={active === "work" && session.id === activeWorkSessionId ? "selected" : ""} key={session.id} onClick={() => onOpenSession(session)}><MessageCircle size={16} /><span><strong>{session.title}</strong><small>{session.model || "聊天"} · {relativeTime(session.updatedAt)}</small></span></button>)}{sessions.length === 0 && <span className="emptyHistory">还没有聊天对话</span>}</>}</section>
    </aside>
  </div>;
}
