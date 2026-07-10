/// <reference types="vite/client" />

interface Window {
  agentDesktop?: {
    platform: string;
    isDesktopClient: boolean;
    getLocalApiToken?: () => Promise<string | undefined>;
    getThemePreference?: () => Promise<"system" | "dark" | "light" | undefined>;
    setThemePreference?: (themePreference: "system" | "dark" | "light") => Promise<"system" | "dark" | "light">;
    selectProjectFolder?: () => Promise<string | undefined>;
    createFolderProject?: (name: string) => Promise<string | undefined>;
  };
}
