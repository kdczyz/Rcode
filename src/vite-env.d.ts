/// <reference types="vite/client" />

interface RcodeAuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  createdAt: string;
  lastLoginAt?: string;
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
    authSession?: () => Promise<RcodeAuthSession | undefined>;
    authLogin?: (details: { identifier: string; password: string }) => Promise<RcodeAuthSession>;
    authRegister?: (details: { email: string; username: string; displayName: string; password: string }) => Promise<RcodeAuthSession>;
    authLogout?: () => Promise<{ ok: boolean }>;
    getThemePreference?: () => Promise<"system" | "dark" | "light" | undefined>;
    setThemePreference?: (themePreference: "system" | "dark" | "light") => Promise<"system" | "dark" | "light">;
    selectProjectFolder?: () => Promise<string | undefined>;
    createFolderProject?: (name: string) => Promise<string | undefined>;
  };
}
