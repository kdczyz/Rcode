import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Computer,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  MonitorCheck,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  ApiError,
  AuthResult,
  readCachedUser,
  readLocalState,
  readToken,
  RemoteCommand,
  RemoteDevice,
  RemoteSnapshot,
  request,
  User,
  writeCachedUser,
  writeLocalState,
  writeToken
} from "./api";
import { ConnectionState, RemoteController } from "./remote";

type Screen = "devices" | "console" | "account";
type RunMode = "workspace_write" | "plan";

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

function eventDescription(event: Record<string, unknown>) {
  if (event.type === "text_delta") return typeof event.delta === "string" ? event.delta : "";
  if (event.type === "workflow_state") return typeof event.label === "string" ? event.label : "电脑正在处理";
  if (event.type === "tool_call") return `调用工具：${String(event.toolName || "未知工具")}`;
  if (event.type === "permission_decision") return typeof event.reason === "string" ? event.reason : "权限检查完成";
  if (event.type === "completed") return typeof event.answer === "string" ? event.answer : "任务已完成";
  if (event.type === "error") return typeof event.message === "string" ? event.message : "任务执行失败";
  if (event.type === "approval_required") return typeof event.reason === "string" ? event.reason : "需要你的批准";
  return "";
}

function shortTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function relativeTime(value: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 20) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

const EMPTY_SNAPSHOT: RemoteSnapshot = { devices: [], commands: [] };
const SNAPSHOT_CACHE_KEY = "remote.snapshot.v1";
const SELECTED_DEVICE_KEY = "remote.selected-device.v1";

function connectionCopy(state: ConnectionState) {
  if (state === "online") return "服务在线";
  if (state === "connecting") return "连接中";
  if (state === "waiting") return "等待重连";
  return "已离线";
}

function mergeRemoteCommand(snapshot: RemoteSnapshot, command: RemoteCommand): RemoteSnapshot {
  return {
    ...snapshot,
    commands: [
      command,
      ...snapshot.commands.filter((item) => item.id !== command.id && item.requestId !== command.requestId)
    ].slice(0, 100)
  };
}

function commandStatusCopy(status: RemoteCommand["status"]) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "awaiting_approval") return "等待审批";
  if (status === "running") return "执行中";
  return "排队中";
}

function serviceHost(url: string) {
  try { return new URL(url).host; } catch { return url; }
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User>();
  const [screen, setScreen] = useState<Screen>("devices");
  const [snapshot, setSnapshot] = useState<RemoteSnapshot>(EMPTY_SNAPSHOT);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [error, setError] = useState("");
  const controllerRef = useRef<RemoteController | undefined>(undefined);

  const selectedDevice = snapshot.devices.find((device) => device.id === selectedDeviceId);
  const selectedCommands = useMemo(
    () => snapshot.commands.filter((command) => command.deviceId === selectedDeviceId),
    [selectedDeviceId, snapshot.commands]
  );
  const selectedEvents = useMemo(() => {
    const ids = new Set(selectedCommands.map((command) => command.id));
    return events.filter((event) => ids.has(event.commandId));
  }, [events, selectedCommands]);
  const selectedApproval = approval && selectedCommands.some((command) => command.id === approval.commandId)
    ? approval
    : undefined;

  const mergeCommand = useCallback((command: RemoteCommand) => {
    setSnapshot((current) => mergeRemoteCommand(current, command));
  }, []);

  useEffect(() => {
    void (async () => {
      const token = await readToken();
      if (token) {
        const [cachedUser, cachedSnapshot, cachedDeviceId] = await Promise.all([
          readCachedUser(),
          readLocalState<RemoteSnapshot>(SNAPSHOT_CACHE_KEY, EMPTY_SNAPSHOT),
          readLocalState(SELECTED_DEVICE_KEY, "")
        ]);
        if (cachedUser) setUser(cachedUser);
        setSnapshot({
          ...cachedSnapshot,
          devices: cachedSnapshot.devices.map((device) => ({ ...device, online: false, ready: false }))
        });
        setSelectedDeviceId(cachedDeviceId);
        try {
          const session = await request<{ user: User }>("/v1/auth/me");
          setUser(session.user);
          await writeCachedUser(session.user);
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) {
            await writeToken();
            await writeCachedUser();
            setUser(undefined);
          } else if (!cachedUser) {
            setError(reason instanceof Error ? reason.message : "无法恢复会话");
          }
        }
      }
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    const controller = new RemoteController({
      onState: setConnection,
      onSnapshot: setSnapshot,
      onCommand: mergeCommand,
      onError: setError,
      onEvent: ({ commandId, event }) => {
        const text = eventDescription(event);
        if (text) setEvents((current) => {
          const type = String(event.type);
          const last = current[current.length - 1];
          if (type === "text_delta" && last?.type === "text_delta" && last.commandId === commandId) {
            return [...current.slice(0, -1), { ...last, text: `${last.text}${text}`.slice(-12_000), at: Date.now() }];
          }
          return [...current.slice(-199), {
            id: `${commandId}:${Date.now()}:${current.length}`,
            commandId,
            type,
            text,
            at: Date.now()
          }];
        });
        if (event.type === "approval_required" && typeof event.approvalId === "string") {
          setApproval({
            approvalId: event.approvalId,
            commandId,
            reason: typeof event.reason === "string" ? event.reason : "电脑请求执行受保护操作",
            risk: event.risk === "high" || event.risk === "medium" ? event.risk : "low",
            toolName: typeof event.toolCall === "object" && event.toolCall && "name" in event.toolCall
              ? String((event.toolCall as { name?: unknown }).name || "")
              : undefined
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
  }, [mergeCommand, user]);

  useEffect(() => {
    if (!user) return;
    void writeLocalState(SNAPSHOT_CACHE_KEY, snapshot);
  }, [snapshot, user]);

  useEffect(() => {
    if (selectedDeviceId) void writeLocalState(SELECTED_DEVICE_KEY, selectedDeviceId);
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId || !snapshot.devices.some((device) => device.id === selectedDeviceId)) {
      const preferred = snapshot.devices.find((device) => device.online) ?? snapshot.devices[0];
      if (preferred) setSelectedDeviceId(preferred.id);
    }
  }, [selectedDeviceId, snapshot.devices]);

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

  async function logout() {
    try { await request("/v1/auth/logout", { method: "POST" }); } catch { /* local logout still continues */ }
    controllerRef.current?.stop();
    await writeToken();
    await writeCachedUser();
    setUser(undefined);
    setSnapshot(EMPTY_SNAPSHOT);
    setEvents([]);
    setApproval(undefined);
    setScreen("devices");
  }

  if (booting) return <Splash />;
  if (!user) return <AuthScreen onAuthenticated={(session) => setUser(session.user)} />;

  return (
    <main className="appShell">
      <header className="topBar">
        {screen === "devices" ? (
          <div className="wordmark"><span>RC</span><strong>Rcode</strong></div>
        ) : (
          <button className="iconButton" onClick={() => setScreen("devices")} aria-label="返回"><ArrowLeft size={21} /></button>
        )}
        <div className={`connectionBadge ${connection}`}>
          {connection === "online" ? <Wifi size={14} /> : connection === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
          {connectionCopy(connection)}
        </div>
        {screen === "devices" && <button className="avatarButton" onClick={() => setScreen("account")} aria-label="账户">{user.displayName.slice(0, 1).toUpperCase()}</button>}
      </header>

      {error && <button className="errorBanner" onClick={() => setError("")}><span>{error}</span><X size={16} /></button>}

      {screen === "devices" && (
        <DeviceScreen
          devices={snapshot.devices}
          commands={snapshot.commands}
          connection={connection}
          onRefresh={() => controllerRef.current?.reconnect()}
          onSelect={(device) => { setSelectedDeviceId(device.id); setScreen("console"); }}
        />
      )}
      {screen === "console" && selectedDevice && (
        <ConsoleScreen
          device={selectedDevice}
          commands={selectedCommands}
          events={selectedEvents}
          approval={selectedApproval}
          canSend={connection === "online" && selectedDevice.online && selectedDevice.ready}
          onSend={(prompt, mode) => sendCommand("agent.run", { prompt, mode })}
          onApproval={(allow) => {
            if (!approval) return;
            if (sendCommand("agent.approve", { approvalId: approval.approvalId, originCommandId: approval.commandId, allow })) {
              setApproval(undefined);
            }
          }}
        />
      )}
      {screen === "account" && <AccountScreen user={user} apiBase={API_BASE} onLogout={() => void logout()} />}
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
        : {
            email: String(form.get("email") || ""),
            username: String(form.get("username") || ""),
            displayName: String(form.get("displayName") || ""),
            password: String(form.get("password") || "")
          };
      const result = await request<AuthResult>(`/v1/auth/${mode}`, { method: "POST", body: JSON.stringify(body) }, false);
      await writeToken(result.token);
      await writeCachedUser(result.user);
      onAuthenticated(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally { setBusy(false); }
  }

  return (
    <main className="authScreen">
      <section className="authIntro">
        <div className="wordmark authWordmark"><span>RC</span><strong>Rcode</strong></div>
        <p className="eyebrow">你的电脑，就在手边</p>
        <h1>离开桌面，<br />工作仍在继续。</h1>
        <p className="authLead">使用与电脑端相同的 Rcode 账号，安全发送任务并查看实时进度。</p>
        <div className="trustLine"><ShieldCheck size={17} /><span>端到端账号隔离 · 敏感操作仍需审批</span></div>
      </section>
      <form className="authForm" onSubmit={submit}>
        <div className="formHeading"><div><h2>{mode === "login" ? "登录" : "创建账号"}</h2><p>{mode === "login" ? "连接你的 Rcode 电脑" : "在手机与电脑之间建立统一身份"}</p></div><LockKeyhole size={21} /></div>
        {mode === "login" ? (
          <label><span>邮箱或用户名</span><input name="identifier" autoCapitalize="none" autoComplete="username" required placeholder="name@example.com" /></label>
        ) : (
          <div className="registerFields">
            <label><span>显示名称</span><input name="displayName" autoComplete="name" required placeholder="你的名字" /></label>
            <label><span>用户名</span><input name="username" autoCapitalize="none" autoComplete="username" required placeholder="rcode_user" /></label>
            <label><span>邮箱</span><input name="email" type="email" autoCapitalize="none" autoComplete="email" required placeholder="name@example.com" /></label>
          </div>
        )}
        <label><span>密码</span><input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : undefined} placeholder="至少 8 位，包含字母和数字" /></label>
        {error && <div className="formError">{error}</div>}
        <button className="primaryButton" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ChevronRight size={18} />}<span>{busy ? "正在验证" : mode === "login" ? "连接电脑" : "创建并登录"}</span></button>
        <button type="button" className="textButton" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "还没有账号？创建账号" : "已有账号？返回登录"}</button>
      </form>
    </main>
  );
}

function DeviceScreen({ devices, commands, connection, onSelect, onRefresh }: {
  devices: RemoteDevice[];
  commands: RemoteCommand[];
  connection: ConnectionState;
  onSelect: (device: RemoteDevice) => void;
  onRefresh: () => void;
}) {
  const onlineCount = devices.filter((device) => device.online).length;
  return (
    <section className="page devicesPage">
      <div className="pageHeading">
        <div><p className="eyebrow">远程工作区</p><h1>选择一台电脑</h1><p>{onlineCount ? `${onlineCount} 台设备可以接收任务` : "打开电脑端 Rcode 后会自动出现在这里"}</p></div>
        <button className="iconButton refreshButton" onClick={onRefresh} disabled={connection === "connecting"} aria-label="刷新"><RefreshCw className={connection === "connecting" ? "spin" : ""} size={19} /></button>
      </div>
      {connection !== "online" && devices.length > 0 && <div className="offlineNotice"><WifiOff size={16} /><span>当前显示上次同步的设备，连接恢复后会自动更新。</span></div>}
      {devices.length === 0 ? (
        <div className="emptyState"><div className="emptyIcon"><MonitorCheck size={31} /></div><h2>还没有已连接的电脑</h2><p>请在电脑端登录同一个 Rcode 账号，并保持应用运行。</p><button className="secondaryButton" onClick={onRefresh}><RefreshCw size={17} />重新检查</button></div>
      ) : (
        <div className="deviceList">
          {devices.map((device) => {
            const latest = commands.find((command) => command.deviceId === device.id);
            return <button className={`deviceRow ${device.online ? "online" : "offline"}`} key={device.id} onClick={() => onSelect(device)}>
              <div className="deviceGlyph">{device.platform === "darwin" ? <Laptop size={25} /> : <Computer size={25} />}<i /></div>
              <div className="deviceCopy"><div><strong>{device.name}</strong><span>{device.online ? device.ready ? "在线 · 可以发送任务" : "在线 · 正在准备" : `离线 · ${relativeTime(device.lastSeenAt)}`}</span></div>{device.projectName && <small>当前项目：{device.projectName}</small>}{latest && <small>最近任务：{commandStatusCopy(latest.status)}</small>}</div>
              <ChevronRight size={20} />
            </button>;
          })}
        </div>
      )}
      <div className="safetyNote"><ShieldCheck size={18} /><div><strong>受控远程执行</strong><p>手机端不会直接执行系统命令。任务仍由电脑端权限规则检查，高风险操作会请求确认。</p></div></div>
    </section>
  );
}

function ConsoleScreen({ device, commands, events, approval, canSend, onSend, onApproval }: {
  device: RemoteDevice;
  commands: RemoteCommand[];
  events: LiveEvent[];
  approval?: ApprovalRequest;
  canSend: boolean;
  onSend: (prompt: string, mode: RunMode) => boolean;
  onApproval: (allow: boolean) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<RunMode>("workspace_write");
  const bottomRef = useRef<HTMLDivElement>(null);
  const active = commands.find((command) => command.action === "agent.run" && ["queued", "running", "awaiting_approval"].includes(command.status));
  const recentRuns = commands.filter((command) => command.action === "agent.run").slice(0, 4);
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [events.length, approval]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || !canSend) return;
    if (onSend(value, mode)) setPrompt("");
  }

  return (
    <section className="consolePage">
      <div className="deviceStatusBar"><div className="deviceGlyph compact">{device.platform === "darwin" ? <Laptop size={21} /> : <Computer size={21} />}<i /></div><div><strong>{device.name}</strong><span>{device.projectName || "当前工作区"}</span></div><span className={`livePill ${device.online ? "online" : ""}`}>{device.online ? "在线" : "离线"}</span></div>
      <div className="timeline">
        {recentRuns.length > 0 && <section className="runHistory"><div className="sectionLabel"><Clock3 size={13} /><span>最近任务</span></div><div className="runHistoryList">{recentRuns.map((command) => <div className="runHistoryRow" key={command.id}><MessageSquareText size={15} /><div><strong>{command.summary || "远程任务"}</strong><span>{shortTime(command.createdAt)} · {commandStatusCopy(command.status)}</span></div><i className={command.status} /></div>)}</div></section>}
        {events.length === 0 && !active ? (
          <div className="consoleWelcome"><div className="welcomeMark"><Sparkles size={27} /></div><h2>向电脑发送第一条任务</h2><p>描述你想完成的工作。Rcode 会在电脑端运行，并将进度实时传回这里。</p><div className="suggestions">{["检查项目有没有构建错误", "整理当前改动并给我总结", "先规划下一步开发任务"].map((text) => <button key={text} onClick={() => setPrompt(text)}>{text}<ChevronRight size={15} /></button>)}</div></div>
        ) : (
          <div className="eventList">
            {active && <div className="activeRun"><LoaderCircle className="spin" size={17} /><div><strong>{active.status === "queued" ? "任务已发送" : active.status === "awaiting_approval" ? "等待你的确认" : "电脑正在执行"}</strong><span>开始于 {shortTime(active.createdAt)}</span></div></div>}
            {events.map((event) => <article className={`eventItem ${event.type}`} key={event.id}><div className="eventDot">{event.type === "completed" ? <Check size={13} /> : event.type === "error" ? <X size={13} /> : <span />}</div><div><p>{event.text}</p><time>{shortTime(event.at)}</time></div></article>)}
            {approval && <div className={`approvalCard risk-${approval.risk}`}><div className="approvalHeading"><ShieldCheck size={20} /><div><strong>电脑请求授权</strong><span>{approval.risk === "high" ? "高风险操作" : approval.risk === "medium" ? "需要注意" : "低风险操作"}</span></div></div><p>{approval.reason}</p>{approval.toolName && <code>{approval.toolName}</code>}<div className="approvalActions"><button onClick={() => onApproval(false)}><X size={17} />拒绝</button><button className="approve" onClick={() => onApproval(true)}><Check size={17} />允许一次</button></div></div>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <form className="composer" onSubmit={submit}>
        <div className="modeSwitch"><button type="button" className={mode === "workspace_write" ? "active" : ""} onClick={() => setMode("workspace_write")}>执行</button><button type="button" className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")}>仅规划</button></div>
        <div className="composerRow"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={1} placeholder={canSend ? "给电脑发送任务…" : "电脑当前不可用"} disabled={!canSend} /><button aria-label="发送" disabled={!canSend || !prompt.trim()}><Send size={19} /></button></div>
        <p><ShieldCheck size={13} />{mode === "plan" ? "仅分析和制定计划，不会修改文件" : "允许项目内修改，敏感操作仍需审批"}</p>
      </form>
    </section>
  );
}

function AccountScreen({ user, apiBase, onLogout }: { user: User; apiBase: string; onLogout: () => void }) {
  return <section className="page accountPage"><div className="profileHero"><div className="profileAvatar">{user.displayName.slice(0, 1).toUpperCase()}</div><h1>{user.displayName}</h1><p>@{user.username}</p></div><div className="settingsList"><div><CircleUserRound size={20} /><span><strong>账号</strong><small>{user.email}</small></span></div><div><Smartphone size={20} /><span><strong>当前设备</strong><small>Android · Rcode Mobile 0.2.1</small></span></div><div><LockKeyhole size={20} /><span><strong>服务地址</strong><small>{serviceHost(apiBase)}</small></span></div></div><div className="accountTrust"><ShieldCheck size={20} /><p>会话令牌仅保存在应用私有存储中。退出登录会清除本机令牌并撤销云端会话。</p></div><button className="logoutButton" onClick={onLogout}><LogOut size={18} />退出登录</button></section>;
}
