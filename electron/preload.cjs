const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentDesktop", {
  platform: process.platform,
  isDesktopClient: true,
  getLocalApiToken: () => ipcRenderer.invoke("agent:get-local-api-token"),
  githubMcpAuthStatus: (details) => ipcRenderer.invoke("agent:github-mcp-auth-status", details),
  githubMcpAuthorize: (details) => ipcRenderer.invoke("agent:github-mcp-authorize", details),
  githubMcpLogout: (details) => ipcRenderer.invoke("agent:github-mcp-logout", details),
  authSession: () => ipcRenderer.invoke("agent:auth-session"),
  authLogin: (details) => ipcRenderer.invoke("agent:auth-login", details),
  authRegister: (details) => ipcRenderer.invoke("agent:auth-register", details),
  authLogout: () => ipcRenderer.invoke("agent:auth-logout"),
  getThemePreference: () => ipcRenderer.invoke("agent:get-theme-preference"),
  setThemePreference: (themePreference) => ipcRenderer.invoke("agent:set-theme-preference", themePreference),
  selectProjectFolder: () => ipcRenderer.invoke("agent:select-folder"),
  createFolderProject: (name) => ipcRenderer.invoke("agent:create-folder-project", name),
  openExternalUrl: (url) => ipcRenderer.invoke("agent:open-external-url", url),
  openLocalPath: (details) => ipcRenderer.invoke("agent:open-local-path", details)
});
