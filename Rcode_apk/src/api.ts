import { Preferences } from "@capacitor/preferences";

export const API_BASE = (import.meta.env.VITE_AUTH_API_URL || "https://rcode-remote-server.kdczyz0728-994.workers.dev").replace(/\/$/, "");
const TOKEN_KEY = "rcode.auth.token.v1";
const USER_KEY = "rcode.auth.user.v1";
const LOCAL_PREFIX = "rcode.mobile.";
const REQUEST_TIMEOUT_MS = 15_000;

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
  ready: boolean;
  online: boolean;
  lastSeenAt: number;
}

export type CommandStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed";

export interface RemoteCommand {
  id: string;
  requestId: string;
  deviceId: string;
  action: "agent.run" | "agent.approve";
  status: CommandStatus;
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteSnapshot {
  devices: RemoteDevice[];
  commands: RemoteCommand[];
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
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}
