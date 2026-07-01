/// <reference types="vite/client" />

interface Window {
  agentDesktop?: {
    platform: string;
    isDesktopClient: boolean;
    selectProjectFolder?: () => Promise<string | undefined>;
    createFolderProject?: (name: string) => Promise<string | undefined>;
  };
}
