const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");

const isDev = !app.isPackaged;
const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "../dist/index.html")}`;

let serverProcess = null;

function startServer() {
  if (isDev) {
    console.log("Dev mode: server should be started separately");
    return;
  }

  const serverPath = path.join(process.resourcesPath, "dist-server-bundle/index.cjs");

  console.log("Starting server from:", serverPath);

  // Check if server file exists
  if (!require("node:fs").existsSync(serverPath)) {
    console.error("Server file not found:", serverPath);
    return;
  }

  serverProcess = fork(serverPath, [], {
    cwd: process.resourcesPath,
    env: {
      ...process.env,
      PORT: "8787"
    },
    silent: false
  });

  serverProcess.on("message", (msg) => {
    console.log("Server message:", msg);
  });

  serverProcess.on("error", (err) => {
    console.error("Server error:", err);
  });

  serverProcess.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
    serverProcess = null;
  });
}

function createWindow() {
  nativeTheme.themeSource = "dark";

  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Agent Console Desktop",
    backgroundColor: "#151515",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    window.loadURL(startUrl);
  } else {
    // In production, wait a bit for server to start then load
    setTimeout(() => {
      window.loadURL(startUrl);
    }, 3000);
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

app.whenReady().then(() => {
  ipcMain.handle("agent:select-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择项目文件夹",
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return undefined;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("agent:create-folder-project", async (_event, rawName) => {
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : "未命名项目";
    const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80);
    const documentsPath = app.getPath("documents") || path.join(os.homedir(), "Documents");
    const projectsRoot = path.join(documentsPath, "Agent Console Projects");
    const targetPath = path.join(projectsRoot, safeName);
    await fs.mkdir(targetPath, { recursive: true });
    return targetPath;
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Agent Console",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "quit", label: "退出" }
        ]
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" }
        ]
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新载入" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" }
        ]
      }
    ])
  );

  // Start the server in production mode
  if (!isDev) {
    startServer();
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
