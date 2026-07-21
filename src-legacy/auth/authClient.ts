export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  createdAt: string;
  lastLoginAt?: string;
  isGuest?: boolean;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
}

export interface AuthCredentials {
  identifier: string;
  password: string;
}

export interface RegistrationDetails {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

type AuthResponse = AuthSession & { token?: string };

const webTokenKey = "rcode.auth.session.v1";
const guestSessionKey = "rcode.auth.guest-session.v1";
const defaultAuthApiUrl = "https://lxqandlzy.me";

function authApiUrl() {
  return (import.meta.env.VITE_AUTH_API_URL || defaultAuthApiUrl).replace(/\/$/, "");
}

function readWebToken() {
  return localStorage.getItem(webTokenKey) ?? undefined;
}

function writeWebToken(token?: string) {
  if (token) localStorage.setItem(webTokenKey, token);
  else localStorage.removeItem(webTokenKey);
}

function readGuestSession(): AuthSession | undefined {
  try {
    const value = localStorage.getItem(guestSessionKey);
    if (!value) return undefined;
    const session = JSON.parse(value) as AuthSession;
    return session.user?.isGuest ? session : undefined;
  } catch {
    localStorage.removeItem(guestSessionKey);
    return undefined;
  }
}

function writeGuestSession(session?: AuthSession) {
  if (session) localStorage.setItem(guestSessionKey, JSON.stringify(session));
  else localStorage.removeItem(guestSessionKey);
}

function canUseWebFallback() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function isMissingDesktopHandler(error: unknown) {
  return error instanceof Error && error.message.includes("No handler registered for 'agent:auth-");
}

async function webRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readWebToken();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${authApiUrl()}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({ error: "认证服务返回了无效响应" }));
  if (!response.ok) {
    if (response.status === 401) writeWebToken();
    throw new Error(typeof data.error === "string" ? data.error : "认证请求失败");
  }
  return data as T;
}

export async function restoreAuthSession(): Promise<AuthSession | undefined> {
  const guestSession = readGuestSession();
  if (guestSession) return guestSession;
  if (window.agentDesktop?.authSession) {
    try {
      const desktopSession = await window.agentDesktop.authSession();
      if (desktopSession) {
        writeWebToken();
        return desktopSession;
      }
      if (!canUseWebFallback()) return undefined;
    } catch (error) {
      if (!isMissingDesktopHandler(error) || !canUseWebFallback()) throw error;
    }
  }
  if (!readWebToken()) return undefined;
  try {
    return await webRequest<AuthSession>("/v1/auth/me");
  } catch {
    return undefined;
  }
}

export function continueAsGuest(): AuthSession {
  const now = new Date();
  const session: AuthSession = {
    user: {
      id: "local-guest",
      email: "仅本机使用",
      username: "guest",
      displayName: "本地游客",
      createdAt: now.toISOString(),
      lastLoginAt: now.toISOString(),
      isGuest: true
    },
    expiresAt: "9999-12-31T23:59:59.999Z"
  };
  writeWebToken();
  writeGuestSession(session);
  return session;
}

export async function signIn(details: AuthCredentials): Promise<AuthSession> {
  writeGuestSession();
  if (window.agentDesktop?.authLogin) {
    try {
      const session = await window.agentDesktop.authLogin(details);
      writeWebToken();
      return session;
    } catch (error) {
      if (!isMissingDesktopHandler(error) || !canUseWebFallback()) throw error;
    }
  }
  const result = await webRequest<AuthResponse>("/v1/auth/login", { method: "POST", body: JSON.stringify(details) });
  writeWebToken(result.token);
  return result;
}

export async function signUp(details: RegistrationDetails): Promise<AuthSession> {
  writeGuestSession();
  if (window.agentDesktop?.authRegister) {
    try {
      const session = await window.agentDesktop.authRegister(details);
      writeWebToken();
      return session;
    } catch (error) {
      if (!isMissingDesktopHandler(error) || !canUseWebFallback()) throw error;
    }
  }
  const result = await webRequest<AuthResponse>("/v1/auth/register", { method: "POST", body: JSON.stringify(details) });
  writeWebToken(result.token);
  return result;
}

export async function signOut(): Promise<void> {
  if (readGuestSession()) {
    writeGuestSession();
    writeWebToken();
    return;
  }
  const hasWebToken = Boolean(readWebToken());
  if (window.agentDesktop?.authLogout) {
    try {
      await window.agentDesktop.authLogout();
      if (!hasWebToken) return;
    } catch (error) {
      if (!isMissingDesktopHandler(error) || !canUseWebFallback()) throw error;
    }
  }
  try {
    await webRequest<{ ok: boolean }>("/v1/auth/logout", { method: "POST" });
  } finally {
    writeWebToken();
  }
}
