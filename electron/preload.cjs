const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentDesktop", {
  platform: process.platform,
  isDesktopClient: true,
  selectProjectFolder: () => ipcRenderer.invoke("agent:select-folder"),
  createFolderProject: (name) => ipcRenderer.invoke("agent:create-folder-project", name)
});
