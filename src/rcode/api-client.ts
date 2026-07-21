/**
 * Rcode server API client.
 *
 * The Rcode backend (server/index.ts) exposes an Express HTTP API on
 * localhost. In dev the web app talks to it through VITE_API_BASE; inside the
 * Electron shell requests go to the embedded server directly and carry the
 * local API token exposed by the preload bridge (window.agentDesktop).
 */

declare global {
  interface Window {
    agentDesktop?: {
      platform?: string;
      isDesktopClient?: boolean;
      getLocalApiToken?: () => Promise<string | undefined>;
      selectProjectFolder?: () => Promise<{ canceled: boolean; path?: string | null }>;
      openExternalUrl?: (url: string) => Promise<void>;
      openLocalPath?: (details: { path: string }) => Promise<void>;
      // The desktop preload exposes many more bridges (auth, MCP, sync…).
      // Loosely typed on purpose: call sites cast to their own shapes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
  }
}

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  (window.location.protocol === "file:" || window.agentDesktop?.isDesktopClient
    ? "http://localhost:8787"
    : "");

let cachedToken: string | null | undefined;

export async function getApiToken(): Promise<string | undefined> {
  if (cachedToken !== undefined) return cachedToken ?? undefined;
  try {
    cachedToken = (await window.agentDesktop?.getLocalApiToken?.()) ?? null;
  } catch {
    cachedToken = null;
  }
  return cachedToken ?? undefined;
}

export async function apiHeaders(json = true): Promise<Record<string, string>> {
  const token = await getApiToken();
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(token ? { "x-agent-token": token } : {})
  };
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = await apiHeaders(init?.body != null);
  return fetch(apiUrl(path), { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
}
