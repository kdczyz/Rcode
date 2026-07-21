/**
 * Web/Electron-renderer implementation of the `window.dsGui` bridge.
 *
 * DeepSeek-GUI's renderer was built for Electron, where a preload script
 * exposes `window.dsGui` backed by IPC to the main process. Rcode runs the
 * renderer against its own Express server, so this module installs a browser
 * implementation instead:
 *
 *  - settings persist to localStorage (AppSettingsV1 shape);
 *  - workspace picking bridges to Rcode's own Electron preload when available;
 *  - runtime/SSE methods are unused (the Rcode provider talks to the server
 *    directly) and remain as inert stubs;
 *  - desktop-only surfaces (terminal, git, file watching, Claw, GUI updater)
 *    return benign "unavailable" results so the UI degrades gracefully.
 */

import type { DsGuiApi } from "../shared/ds-gui-api";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  defaultClawSettings,
  defaultWriteSettings,
  type AppSettingsPatch,
  type AppSettingsV1
} from "../shared/app-settings";

const SETTINGS_KEY = "rcode.dsgui.settings.v1";

function defaultSettings(): AppSettingsV1 {
  return {
    version: 1,
    locale: "zh",
    theme: "system",
    uiFontScale: "medium",
    agentProvider: "deepseek-runtime",
    deepseek: {
      binaryPath: "",
      port: 8765,
      autoStart: false,
      // Rcode manages model access through its own provider system, so the
      // DeepSeek key is a non-empty placeholder to skip the first-run dialog.
      apiKey: "rcode-managed",
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      runtimeToken: "",
      extraCorsOrigins: [],
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    },
    workspaceRoot: "",
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: false },
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    guiUpdate: { channel: "stable" }
  };
}

function readSettings(): AppSettingsV1 {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<AppSettingsV1>;
    const base = defaultSettings();
    return {
      ...base,
      ...parsed,
      deepseek: { ...base.deepseek, ...(parsed.deepseek ?? {}) },
      write: parsed.write ?? base.write,
      claw: parsed.claw ?? base.claw,
      log: { ...base.log, ...(parsed.log ?? {}) },
      notifications: { ...base.notifications, ...(parsed.notifications ?? {}) },
      guiUpdate: { ...base.guiUpdate, ...(parsed.guiUpdate ?? {}) }
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(patch: AppSettingsPatch): AppSettingsV1 {
  const current = readSettings();
  const next: AppSettingsV1 = {
    ...current,
    ...patch,
    deepseek: { ...current.deepseek, ...(patch.deepseek ?? {}) },
    log: { ...current.log, ...(patch.log ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    write: (patch.write as AppSettingsV1["write"]) ?? current.write,
    claw: (patch.claw as AppSettingsV1["claw"]) ?? current.claw,
    guiUpdate: { ...current.guiUpdate, ...(patch.guiUpdate ?? {}) }
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage full — keep in-memory only */
  }
  return next;
}

function noop(): () => void {
  return () => undefined;
}

function unavailable(name: string): Error {
  return new Error(`${name} is not available in the Rcode web runtime`);
}

const api: DsGuiApi = {
  platform: (window.agentDesktop?.platform as NodeJS.Platform | undefined) ?? "darwin",

  /* ------------------------------- settings ------------------------------ */
  getSettings: async () => readSettings(),
  setSettings: async (patch) => writeSettings(patch),

  /* ------------------------ runtime request (unused) --------------------- */
  runtimeRequest: async () => ({ ok: false, status: 501, body: "runtimeRequest is handled by the Rcode provider" }),
  fetchUpstreamModels: async () => ({ ok: false, models: [], message: "unavailable" } as never),

  /* --------------------------------- claw -------------------------------- */
  getClawStatus: async () => ({ ok: false, running: false }) as never,
  runClawTask: async () => ({ ok: false, message: "Claw is unavailable" }) as never,
  startClawImInstallQr: async () => ({ ok: false, message: "Claw is unavailable" }) as never,
  pollClawImInstall: async () => ({ ok: false, status: "error", message: "Claw is unavailable" }) as never,
  mirrorClawChannelMessageToFeishu: async () => ({ ok: false, message: "Claw is unavailable" }) as never,
  createClawTaskFromText: async () => ({ ok: false, message: "Claw is unavailable" }) as never,
  onClawChannelActivity: () => noop(),

  /* --------------------------- deepseek runtime -------------------------- */
  deepseekSpawnIfNeeded: async () => ({ ok: true }) as never,
  prepareDeepseekBinary: async () => ({ ok: false, message: "managed by Rcode" }) as never,
  checkDeepseekUpdate: async () => ({ ok: false, message: "managed by Rcode" }) as never,
  installDeepseekUpdate: async () => ({ ok: false, message: "managed by Rcode" }) as never,
  getDeepseekConfigFile: async () => ({ path: "", content: "", exists: false }),
  setDeepseekConfigFile: async () => ({ ok: true, path: "" }),
  openDeepseekConfigDir: async () => ({ ok: false, message: "managed by Rcode" }),
  diagnoseDeepseekRuntime: async () => {
    throw unavailable("diagnoseDeepseekRuntime");
  },

  /* ------------------------------- workspace ----------------------------- */
  pickWorkspaceDirectory: async (defaultPath?: string) => {
    void defaultPath;
    const picker = window.agentDesktop?.selectProjectFolder;
    if (picker) {
      const result = await picker();
      return { canceled: result.canceled, path: result.path ?? null };
    }
    const manual = window.prompt("输入工作目录的绝对路径：");
    return manual ? { canceled: false, path: manual.trim() } : { canceled: true, path: null };
  },
  listWorkspaceDirectory: async () => ({ ok: false, entries: [], message: "unavailable" }) as never,
  resolveWorkspaceFile: async () => ({ ok: false, message: "unavailable" }) as never,
  readWorkspaceFile: async () => ({ ok: false, message: "unavailable" }) as never,
  readWorkspaceImage: async () => ({ ok: false, message: "unavailable" }) as never,
  writeWorkspaceFile: async () => ({ ok: false, message: "unavailable" }) as never,
  createWorkspaceFile: async () => ({ ok: false, message: "unavailable" }) as never,
  createWorkspaceDirectory: async () => ({ ok: false, message: "unavailable" }) as never,
  saveWorkspaceClipboardImage: async () => ({ ok: false, message: "unavailable" }) as never,
  renameWorkspaceEntry: async () => ({ ok: false, message: "unavailable" }) as never,
  deleteWorkspaceEntry: async () => ({ ok: false, message: "unavailable" }) as never,
  watchWorkspaceFile: async () => ({ ok: false, message: "unavailable" }) as never,
  unwatchWorkspaceFile: async () => false,
  onWorkspaceFileChanged: () => noop(),

  /* --------------------------------- skill ------------------------------- */
  saveSkillFile: async () => ({ ok: false, message: "unavailable" }) as never,
  openSkillRoot: async () => ({ ok: false, message: "unavailable" }),

  /* ---------------------------------- git -------------------------------- */
  getGitBranches: async () => ({ ok: false, branches: [], message: "unavailable" }) as never,
  switchGitBranch: async () => ({ ok: false, message: "unavailable" }) as never,
  createAndSwitchGitBranch: async () => ({ ok: false, message: "unavailable" }) as never,

  /* -------------------------------- editors ------------------------------ */
  listEditors: async () => ({ ok: true, editors: [] }) as never,
  openEditorPath: async (options) => {
    const opener = window.agentDesktop?.openLocalPath;
    if (opener && options && typeof (options as { path?: string }).path === "string") {
      await opener({ path: (options as { path: string }).path });
      return { ok: true } as never;
    }
    return { ok: false, message: "unavailable" } as never;
  },

  /* -------------------------------- terminal ----------------------------- */
  createTerminalSession: async () => ({ ok: false, message: "terminal is unavailable" }) as never,
  writeTerminalSession: async () => false,
  resizeTerminalSession: async () => false,
  closeTerminalSession: async () => false,
  onTerminalData: () => noop(),
  onTerminalExit: () => noop(),

  /* --------------------------------- write ------------------------------- */
  exportWriteDocument: async () => ({ ok: false, message: "unavailable" }) as never,
  copyWriteDocumentAsRichText: async () => ({ ok: false, message: "unavailable" }) as never,
  requestWriteInlineCompletion: async () => ({ ok: false, message: "unavailable" }) as never,

  /* ------------------------------- SSE (unused) -------------------------- */
  startSse: async () => ({ ok: false, message: "handled by the Rcode provider" }) as never,
  stopSse: async () => false,
  onSseEvent: () => noop(),
  onSseEnd: () => noop(),
  onSseError: () => noop(),

  /* --------------------------------- misc -------------------------------- */
  openExternal: async (url) => {
    const opener = window.agentDesktop?.openExternalUrl;
    if (opener) {
      await opener(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },
  showTurnCompleteNotification: async () => ({ ok: true, shown: false }) as never,
  getAppVersion: async () => "0.1.0",
  getGuiUpdateState: async () => ({ status: "idle" }) as never,
  checkGuiUpdate: async () => ({ ok: false, message: "updates are managed by Rcode" }) as never,
  downloadGuiUpdate: async () => ({ ok: false, message: "updates are managed by Rcode" }) as never,
  installGuiUpdate: async () => ({ ok: false, currentVersion: "0.1.0", message: "updates are managed by Rcode" }),
  onGuiUpdateState: () => noop(),
  logError: async (category, message, detail) => {
    console.error(`[dsGui:${category}] ${message}`, detail ?? "");
  },
  getLogPath: async () => "",
  openLogDir: async () => ({ ok: false, message: "unavailable" })
};

export function installDsGuiBridge(): void {
  if (typeof window !== "undefined" && !window.dsGui) {
    window.dsGui = api;
  }
}
