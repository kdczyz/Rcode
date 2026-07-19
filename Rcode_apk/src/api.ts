import { Preferences } from "@capacitor/preferences";

export const API_BASE = (import.meta.env.VITE_AUTH_API_URL || "https://lxqandlzy.me").replace(/\/$/, "");
const TOKEN_KEY = "rcode.auth.token.v1";
const USER_KEY = "rcode.auth.user.v1";
const LOCAL_PREFIX = "rcode.mobile.";
const REQUEST_TIMEOUT_MS = 15_000;
const WORK_REQUEST_TIMEOUT_MS = 65_000;
const WORK_STREAM_TIMEOUT_MS = 125_000;
const WORK_IMAGE_STREAM_TIMEOUT_MS = 195_000;

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
}

export interface AuthResult {
  token: string;
  user: User;
  expiresAt: string;
}

export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  appVersion?: string;
  projectName?: string;
  workspace?: RemoteWorkspace;
  ready: boolean;
  online: boolean;
  lastSeenAt: number;
}

export interface RemoteWorkspaceSession {
  id: string;
  title: string;
  updatedAt: string;
  conversationId?: string;
}

export interface RemoteWorkspaceProject {
  id: string;
  name: string;
  sessions: RemoteWorkspaceSession[];
}

export interface RemoteWorkspace {
  projects: RemoteWorkspaceProject[];
  models: string[];
  defaultModel?: string;
  activeProjectId?: string;
}

export type CommandStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed";

export interface RemoteCommand {
  id: string;
  requestId: string;
  deviceId: string;
  action: "agent.run" | "agent.approve";
  status: CommandStatus;
  summary?: string;
  projectId?: string;
  sessionId?: string;
  model?: string;
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteHistoryEvent {
  id: string;
  commandId: string;
  type: string;
  event: Record<string, unknown>;
  createdAt: number;
}

export interface RemoteSnapshot {
  devices: RemoteDevice[];
  commands: RemoteCommand[];
  events?: RemoteHistoryEvent[];
}

export async function readToken() {
  return (await Preferences.get({ key: TOKEN_KEY })).value ?? undefined;
}

export async function writeToken(token?: string) {
  if (token) await Preferences.set({ key: TOKEN_KEY, value: token });
  else await Preferences.remove({ key: TOKEN_KEY });
}

export async function readCachedUser() {
  const value = (await Preferences.get({ key: USER_KEY })).value;
  if (!value) return undefined;
  try { return JSON.parse(value) as User; } catch { return undefined; }
}

export async function writeCachedUser(user?: User) {
  if (user) await Preferences.set({ key: USER_KEY, value: JSON.stringify(user) });
  else await Preferences.remove({ key: USER_KEY });
}

export async function readLocalState<T>(key: string, fallback: T): Promise<T> {
  const value = (await Preferences.get({ key: `${LOCAL_PREFIX}${key}` })).value;
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function writeLocalState(key: string, value: unknown) {
  await Preferences.set({ key: `${LOCAL_PREFIX}${key}`, value: JSON.stringify(value) });
}

export async function request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (authenticated) {
    const token = await readToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), path === "/v1/work/images" ? 190_000 : path === "/v1/work/chat" ? WORK_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: controller.signal });
    const body = await response.json().catch(() => ({ error: "服务器返回格式不正确" }));
    if (!response.ok) {
      if (response.status === 401) {
        await writeToken();
        await writeCachedUser();
      }
      throw new ApiError(
        typeof body.error === "string" ? body.error : `请求失败 (${response.status})`,
        response.status,
        typeof body.code === "string" ? body.code : undefined
      );
    }
    return body as T;
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    if (controller.signal.aborted && !init.signal?.aborted) throw new Error("连接超时，请检查网络后重试");
    if (reason instanceof TypeError) throw new Error("无法连接到 Rcode 服务，请检查网络后重试");
    throw reason instanceof Error ? reason : new Error("网络请求失败，请稍后重试");
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

export type WorkStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "image"; model: string; images: GeneratedImage[] }
  | { type: "done"; model: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: "error"; error: string };

export interface GeneratedImage {
  id: string;
  name: string;
  mimeType: string;
  dataUrl?: string;
  url?: string;
  revisedPrompt?: string;
}

export async function generateWorkImage(payload: {
  prompt: string;
  providerId?: string;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
}) {
  return request<{ providerId: string; model: string; images: GeneratedImage[] }>("/v1/work/images", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function streamWorkChat(
  payload: { messages: Array<{ role: "user" | "assistant"; content: string }>; providerId?: string; model?: string; imageModel?: string; thinkingMode?: "fast" | "balanced" | "deep"; autoImage?: boolean },
  onEvent: (event: WorkStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
  const token = await readToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), payload.autoImage ? WORK_IMAGE_STREAM_TIMEOUT_MS : WORK_STREAM_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${API_BASE}/v1/work/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `请求失败 (${response.status})` })) as { error?: string; code?: string };
      if (response.status === 401) {
        await writeToken();
        await writeCachedUser();
      }
      throw new ApiError(body.error || `请求失败 (${response.status})`, response.status, body.code);
    }
    if (!response.body) throw new Error("服务器未返回实时响应");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    const processBlock = (block: string) => {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) return;
      let event: WorkStreamEvent;
      try { event = JSON.parse(data) as WorkStreamEvent; } catch { return; }
      if (event.type === "error") throw new Error(event.error || "实时回复中断");
      if (event.type === "done") completed = true;
      onEvent(event);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) processBlock(block);
      // `done` is the protocol-level end marker. Close locally right away even
      // when an intermediary leaves the HTTP connection alive for a moment.
      if (completed) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!completed) {
      buffer += decoder.decode();
      if (buffer.trim()) processBlock(buffer);
    }
    if (!completed) throw new Error("实时回复提前结束，请重试");
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    if (signal?.aborted) throw new DOMException("对话已停止", "AbortError");
    if (controller.signal.aborted) throw new Error("实时回复超时，请稍后重试");
    if (reason instanceof TypeError) throw new Error("无法连接到 Rcode 服务，请检查网络后重试");
    throw reason instanceof Error ? reason : new Error("实时回复失败，请稍后重试");
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}
