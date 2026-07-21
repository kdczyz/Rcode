/// <reference types="vite/client" />

interface RcodeAuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  createdAt: string;
  lastLoginAt?: string;
  isGuest?: boolean;
}

interface RcodeAuthSession {
  user: RcodeAuthUser;
  expiresAt: string;
}

interface Window {
  agentDesktop?: {
    platform: string;
    isDesktopClient: boolean;
    getLocalApiToken?: () => Promise<string | undefined>;
    githubMcpAuthStatus?: (details: { apiBase: string }) => Promise<{ authorized: boolean }>;
    githubMcpAuthorize?: (details: { clientId: string; clientSecret: string; apiBase: string }) => Promise<{ ok: boolean; login?: string; scope?: string }>;
    githubMcpLogout?: (details: { apiBase: string }) => Promise<{ ok: boolean }>;
    authSession?: () => Promise<RcodeAuthSession | undefined>;
    authLogin?: (details: { identifier: string; password: string }) => Promise<RcodeAuthSession>;
    authRegister?: (details: { email: string; username: string; displayName: string; password: string }) => Promise<RcodeAuthSession>;
    authLogout?: () => Promise<{ ok: boolean }>;
    syncWorkAiProvider?: (details?: { providerId?: string }) => Promise<{
      ok: boolean;
      provider: { id: string; displayName: string; model: string };
      config: { configured: boolean; model?: string; apiKeyPreview?: string; updatedAt?: string };
    }>;
    syncAllWorkAiProviders?: () => Promise<{
      ok: boolean;
      providerCount: number;
      modelCount: number;
    }>;
    remoteUpdateDevice?: (details: {
      projects: Array<{
        id: string;
        name: string;
        path?: string;
        sessions: Array<{ id: string; title: string; updatedAt: string; conversationId?: string }>;
      }>;
      models: string[];
      defaultModel?: string;
      activeProjectId?: string;
    }) => Promise<{ ok: boolean }>;
    getThemePreference?: () => Promise<"system" | "dark" | "light" | undefined>;
    setThemePreference?: (themePreference: "system" | "dark" | "light") => Promise<"system" | "dark" | "light">;
    selectProjectFolder?: () => Promise<string | undefined>;
    createFolderProject?: (name: string) => Promise<string | undefined>;
    openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
    openLocalPath?: (details: { path: string; basePath?: string }) => Promise<{ ok: boolean; error?: string }>;
  };
}
