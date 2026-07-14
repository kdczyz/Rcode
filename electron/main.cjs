const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");

const isDev = !app.isPackaged;
const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "../dist/index.html")}`;

let serverProcess = null;
const localApiToken = process.env.AGENT_LOCAL_TOKEN || crypto.randomBytes(32).toString("base64url");
let volatileAuthToken;
const preferencesPath = () => path.join(app.getPath("userData"), "preferences.json");
const authSessionPath = () => path.join(app.getPath("userData"), "auth-session.bin");
const authApiUrl = () => (process.env.RCODE_AUTH_API_URL || "https://rcode-auth.kdczyz0728-994.workers.dev").replace(/\/$/, "");

async function readAuthToken() {
  if (volatileAuthToken) return volatileAuthToken;
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    const encrypted = await fs.readFile(authSessionPath());
    volatileAuthToken = safeStorage.decryptString(encrypted);
    return volatileAuthToken;
  } catch {
    return undefined;
  }
}

async function writeAuthToken(token) {
  volatileAuthToken = token;
  if (!safeStorage.isEncryptionAvailable()) return;
  await fs.mkdir(path.dirname(authSessionPath()), { recursive: true });
  await fs.writeFile(authSessionPath(), safeStorage.encryptString(token), { mode: 0o600 });
}

async function clearAuthToken() {
  volatileAuthToken = undefined;
  try {
    await fs.unlink(authSessionPath());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function authRequest(pathname, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.authenticated) {
    const token = await readAuthToken();
    if (!token) return undefined;
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${authApiUrl()}${pathname}`, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({ error: "认证服务返回了无效响应" }));
  if (!response.ok) {
    if (response.status === 401) await clearAuthToken();
    throw new Error(typeof data.error === "string" ? data.error : "认证请求失败");
  }
  return data;
}

async function migrateLegacyDatabase(databasePath) {
  const legacyPath = path.join(process.resourcesPath, "data", "agent-console.sqlite");
  try {
    await fs.access(databasePath);
    return;
  } catch {
    // No persistent database yet; try to carry forward state from older builds.
  }
  try {
    await fs.access(legacyPath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await fs.copyFile(`${legacyPath}${suffix}`, `${databasePath}${suffix}`);
      } catch {
        // WAL/SHM files are optional.
      }
    }
  } catch {
    // A fresh install has no legacy database to migrate.
  }
}

async function startServer() {
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

  const databasePath = path.join(app.getPath("userData"), "agent-console.sqlite");
  await migrateLegacyDatabase(databasePath);

  serverProcess = fork(serverPath, [], {
    cwd: process.resourcesPath,
    env: {
      ...process.env,
      AGENT_LOCAL_TOKEN: localApiToken,
      // Runtime state must live outside the signed/read-only application bundle.
      // This also keeps provider/API settings across client upgrades.
      LOCAL_DATABASE_PATH: databasePath,
      HOST: "127.0.0.1",
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

async function waitForServer(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8787/api/health", {
        headers: { "x-agent-token": localApiToken }
      });
      if (response.ok) return true;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Rcode Desktop",
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
    waitForServer().then(() => window.loadURL(startUrl));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

app.whenReady().then(async () => {
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
    const projectsRoot = path.join(documentsPath, "Rcode Projects");
    const targetPath = path.join(projectsRoot, safeName);
    await fs.mkdir(targetPath, { recursive: true });
    return targetPath;
  });

  ipcMain.handle("agent:get-local-api-token", async () => localApiToken);
  ipcMain.handle("agent:auth-session", async () => authRequest("/v1/auth/me", { authenticated: true }));
  ipcMain.handle("agent:auth-login", async (_event, details) => {
    const result = await authRequest("/v1/auth/login", { method: "POST", body: details });
    if (!result?.token) throw new Error("认证服务未返回会话 Token");
    await writeAuthToken(result.token);
    return { user: result.user, expiresAt: result.expiresAt };
  });
  ipcMain.handle("agent:auth-register", async (_event, details) => {
    const result = await authRequest("/v1/auth/register", { method: "POST", body: details });
    if (!result?.token) throw new Error("认证服务未返回会话 Token");
    await writeAuthToken(result.token);
    return { user: result.user, expiresAt: result.expiresAt };
  });
  ipcMain.handle("agent:auth-logout", async () => {
    try {
      await authRequest("/v1/auth/logout", { method: "POST", authenticated: true });
    } finally {
      await clearAuthToken();
    }
    return { ok: true };
  });
  ipcMain.handle("agent:get-theme-preference", async () => {
    try {
      const raw = await fs.readFile(preferencesPath(), "utf8");
      const parsed = JSON.parse(raw);
      return parsed.themePreference;
    } catch {
      return undefined;
    }
  });
  ipcMain.handle("agent:set-theme-preference", async (_event, themePreference) => {
    const value = themePreference === "light" || themePreference === "dark" || themePreference === "system"
      ? themePreference
      : "system";
    await fs.mkdir(path.dirname(preferencesPath()), { recursive: true });
    await fs.writeFile(preferencesPath(), JSON.stringify({ themePreference: value }, null, 2));
    return value;
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Rcode",
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
    await startServer();
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
