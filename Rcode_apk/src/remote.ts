import {
  createId,
  readToken,
  RemoteCommand,
  RemoteSnapshot,
  request
} from "./api";

export type ConnectionState = "offline" | "connecting" | "online" | "waiting";
export type RemoteAction = "agent.run" | "agent.approve";

export interface CommandEventMessage {
  commandId: string;
  event: Record<string, unknown>;
}

interface RemoteControllerCallbacks {
  onState: (state: ConnectionState) => void;
  onSnapshot: (snapshot: RemoteSnapshot) => void;
  onCommand: (command: RemoteCommand) => void;
  onEvent: (message: CommandEventMessage) => void;
  onError: (message: string) => void;
}

const HEARTBEAT_MS = 25_000;
const STALE_CONNECTION_MS = 60_000;

export class RemoteController {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private heartbeatTimer?: number;
  private wanted = false;
  private attempt = 0;
  private generation = 0;
  private lastMessageAt = 0;

  constructor(private readonly callbacks: RemoteControllerCallbacks) {}

  start() {
    if (this.wanted) return;
    this.wanted = true;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    document.addEventListener("visibilitychange", this.handleVisibility);
    void this.open();
  }

  stop() {
    this.wanted = false;
    this.generation += 1;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "controller stopped");
    this.callbacks.onState("offline");
  }

  reconnect() {
    if (!this.wanted) return;
    this.attempt = 0;
    this.generation += 1;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "manual reconnect");
    void this.open();
  }

  sendCommand(deviceId: string, action: RemoteAction, payload: Record<string, unknown>): RemoteCommand {
    const socket = this.socket;
    if (!deviceId || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("远程连接尚未就绪");
    const requestId = createId("request");
    socket.send(JSON.stringify({ type: "command.create", requestId, deviceId, action, payload }));
    const now = Date.now();
    return {
      id: `pending:${requestId}`,
      requestId,
      deviceId,
      action,
      status: "queued",
      summary: action === "agent.run" && typeof payload.prompt === "string" ? payload.prompt : undefined,
      createdAt: now,
      updatedAt: now
    };
  }

  private readonly handleOnline = () => {
    if (!this.wanted) return;
    this.attempt = 0;
    this.callbacks.onError("");
    this.reconnect();
  };

  private readonly handleOffline = () => {
    this.generation += 1;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "network offline");
    this.callbacks.onState("waiting");
    this.callbacks.onError("网络不可用，恢复后会自动重连");
  };

  private readonly handleVisibility = () => {
    if (document.visibilityState !== "visible" || !this.wanted) return;
    if (!this.socket || Date.now() - this.lastMessageAt > STALE_CONNECTION_MS) this.reconnect();
  };

  private clearTimers() {
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect() {
    if (!this.wanted || navigator.onLine === false) {
      this.callbacks.onState("waiting");
      return;
    }
    const delay = Math.min(30_000, 2_000 * Math.pow(1.7, this.attempt++));
    this.callbacks.onState("waiting");
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => void this.open(), delay);
  }

  private async open() {
    if (!this.wanted) return;
    if (navigator.onLine === false) {
      this.callbacks.onState("waiting");
      return;
    }
    const generation = ++this.generation;
    this.clearTimers();
    this.callbacks.onState("connecting");
    try {
      if (!await readToken() || !this.wanted || generation !== this.generation) return;
      const ticket = await request<{ url: string }>("/v1/remote/ticket", {
        method: "POST",
        body: JSON.stringify({ role: "controller" })
      });
      if (!this.wanted || generation !== this.generation) return;
      if (!ticket.url || !/^wss?:\/\//i.test(ticket.url)) throw new Error("远程服务返回了无效连接地址");
      const socket = new WebSocket(ticket.url);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket || generation !== this.generation) return;
        this.attempt = 0;
        this.lastMessageAt = Date.now();
        this.callbacks.onState("online");
        this.callbacks.onError("");
        this.heartbeatTimer = window.setInterval(() => {
          if (this.socket !== socket) return;
          if (Date.now() - this.lastMessageAt > STALE_CONNECTION_MS) {
            socket.close(4000, "heartbeat timeout");
            return;
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, HEARTBEAT_MS);
      };
      socket.onmessage = (message) => {
        if (this.socket !== socket) return;
        this.lastMessageAt = Date.now();
        let body: Record<string, unknown>;
        try { body = JSON.parse(String(message.data)) as Record<string, unknown>; } catch { return; }
        if ((body.type === "remote.ready" || body.type === "remote.snapshot") && body.snapshot) {
          this.callbacks.onSnapshot(body.snapshot as unknown as RemoteSnapshot);
        } else if ((body.type === "command.accepted" || body.type === "command.updated") && body.command) {
          this.callbacks.onCommand(body.command as unknown as RemoteCommand);
        } else if (body.type === "command.event" && typeof body.commandId === "string" && body.event && typeof body.event === "object") {
          this.callbacks.onEvent({ commandId: body.commandId, event: body.event as Record<string, unknown> });
        } else if (body.type === "remote.error") {
          this.callbacks.onError(typeof body.error === "string" ? body.error : "远程连接发生错误");
        }
      };
      socket.onerror = () => {
        if (this.socket === socket) this.callbacks.onError("远程连接暂时不可用，正在重试");
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        this.scheduleReconnect();
      };
    } catch (reason) {
      if (!this.wanted || generation !== this.generation) return;
      this.socket = undefined;
      this.callbacks.onError(reason instanceof Error ? reason.message : "远程连接失败");
      this.scheduleReconnect();
    }
  }
}
