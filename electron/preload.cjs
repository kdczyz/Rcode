const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentDesktop", {
  platform: process.platform,
  isDesktopClient: true,
  getLocalApiToken: () => ipcRenderer.invoke("agent:get-local-api-token"),
  authSession: () => ipcRenderer.invoke("agent:auth-session"),
  authLogin: (details) => ipcRenderer.invoke("agent:auth-login", details),
  authRegister: (details) => ipcRenderer.invoke("agent:auth-register", details),
  authLogout: () => ipcRenderer.invoke("agent:auth-logout"),
  getThemePreference: () => ipcRenderer.invoke("agent:get-theme-preference"),
  setThemePreference: (themePreference) => ipcRenderer.invoke("agent:set-theme-preference", themePreference),
  selectProjectFolder: () => ipcRenderer.invoke("agent:select-folder"),
  createFolderProject: (name) => ipcRenderer.invoke("agent:create-folder-project", name)
});
