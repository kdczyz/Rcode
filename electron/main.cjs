const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const { createServer } = require("node:http");
const { fileURLToPath } = require("node:url");

const isDev = !app.isPackaged;
const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "../dist/index.html")}`;

let serverProcess = null;
const localApiToken = process.env.AGENT_LOCAL_TOKEN || crypto.randomBytes(32).toString("base64url");
let volatileAuthToken;
let volatileGithubMcpToken;
let remoteSocket;
let remoteReconnectTimer;
let remoteHeartbeatTimer;
let remoteConnectionWanted = false;
let remoteWorkspace = { projects: [], models: [], defaultModel: undefined, activeProjectId: undefined };
let remoteCommandRunning = false;
let activeRemoteCommand;
let activeRemoteAbortController;
const remoteCommandQueue = [];
const receivedRemoteCommandIds = new Set();
const remoteReliableOutbox = [];
const REMOTE_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const preferencesPath = () => path.join(app.getPath("userData"), "preferences.json");
const authSessionPath = () => path.join(app.getPath("userData"), "auth-session.bin");
const githubMcpSessionPath = () => path.join(app.getPath("userData"), "github-mcp-oauth.bin");
const remoteDevicePath = () => path.join(app.getPath("userData"), "remote-device.json");
const authApiUrl = () => (process.env.RCODE_AUTH_API_URL || "https://lxqandlzy.me").replace(/\/$/, "");
const localAgentApiUrl = () => process.env.RCODE_LOCAL_API_URL || (isDev ? "http://127.0.0.1:8789" : "http://127.0.0.1:8787");
const githubOauthCallbackPath = "/oauth/github/callback";

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

async function readGithubMcpToken() {
  if (volatileGithubMcpToken) return volatileGithubMcpToken;
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    const encrypted = await fs.readFile(githubMcpSessionPath());
    volatileGithubMcpToken = safeStorage.decryptString(encrypted);
    return volatileGithubMcpToken;
  } catch {
    return undefined;
  }
}

async function writeGithubMcpToken(token) {
  volatileGithubMcpToken = token;
  if (!safeStorage.isEncryptionAvailable()) return;
  await fs.mkdir(path.dirname(githubMcpSessionPath()), { recursive: true });
  await fs.writeFile(githubMcpSessionPath(), safeStorage.encryptString(token), { mode: 0o600 });
}

async function clearGithubMcpToken() {
  volatileGithubMcpToken = undefined;
  try {
    await fs.unlink(githubMcpSessionPath());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function localAgentApiBase(rawBase) {
  const parsed = new URL(typeof rawBase === "string" && rawBase ? rawBase : "http://127.0.0.1:8787");
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error("GitHub OAuth token 只能同步到本机 Rcode 服务");
  }
  return parsed.origin;
}

async function syncGithubMcpToken(rawApiBase, token) {
  const response = await fetch(`${localAgentApiBase(rawApiBase)}/api/mcp/servers/github/runtime-token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-token": localApiToken },
    body: JSON.stringify({ token: token || "" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "无法同步 GitHub OAuth token");
}

async function githubOAuthPost(url, values) {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error_description === "string" ? data.error_description : `GitHub OAuth 请求失败 (${response.status})`);
  return data;
}

function githubOauthCallbackPage(ok) {
  const title = ok ? "GitHub 授权完成" : "GitHub 授权失败";
  const message = ok ? "已安全返回 Rcode，可以关闭此页面。" : "未能完成授权，请返回 Rcode 查看错误。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f5;color:#181817;font:16px system-ui,-apple-system,sans-serif}.card{max-width:420px;padding:36px;border:1px solid #ddd;border-radius:18px;background:#fff;box-shadow:0 18px 60px rgba(0,0,0,.08)}h1{margin:0 0 12px;font-size:24px}p{margin:0;color:#666;line-height:1.6}</style></head><body><main class="card"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

async function startGithubOauthCallback(expectedState) {
  let settled = false;
  let timeout;
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname !== githubOauthCallbackPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const rejectOauth = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(githubOauthCallbackPage(false));
      rejectCallback(new Error(message));
    };
    if (requestUrl.searchParams.get("state") !== expectedState) {
      rejectOauth("GitHub OAuth state 校验失败，请重试");
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) {
      rejectOauth(oauthError === "access_denied" ? "你取消了 GitHub 授权" : `GitHub OAuth 返回错误：${oauthError}`);
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      rejectOauth("GitHub OAuth 回调缺少授权码");
      return;
    }
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    let responded = false;
    resolveCallback({
      code,
      complete(ok) {
        if (responded) return;
        responded = true;
        response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(githubOauthCallbackPage(ok));
      }
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法启动 GitHub OAuth 本地回调");
  }
  timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCallback(new Error("GitHub 浏览器授权已超时，请重试"));
    server.close();
  }, 10 * 60 * 1000);
  return {
    redirectUri: `http://127.0.0.1:${address.port}${githubOauthCallbackPath}`,
    callback,
    close() {
      clearTimeout(timeout);
      server.close();
    }
  };
}

async function githubIdentity(accessToken) {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "Rcode" }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.login !== "string") throw new Error("GitHub OAuth token 身份验证失败");
  return data.login;
}

function focusRcodeWindow() {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function authorizeGithubMcp(_event, details) {
  const clientId = typeof details?.clientId === "string" ? details.clientId.trim() : "";
  const clientSecret = typeof details?.clientSecret === "string" ? details.clientSecret.trim() : "";
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) throw new Error("请输入有效的 GitHub OAuth Client ID");
  if (clientSecret.length < 8 || clientSecret.length > 256) throw new Error("请输入有效的 GitHub OAuth Client Secret");
  const state = crypto.randomBytes(32).toString("base64url");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const callbackServer = await startGithubOauthCallback(state);
  let callbackResult;
  try {
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
    authorizeUrl.searchParams.set("scope", "repo read:org");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("prompt", "select_account");
    await shell.openExternal(authorizeUrl.toString());
    callbackResult = await callbackServer.callback;
    const result = await githubOAuthPost("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      client_secret: clientSecret,
      code: callbackResult.code,
      redirect_uri: callbackServer.redirectUri,
      code_verifier: codeVerifier
    });
    if (!result.access_token) throw new Error(typeof result.error_description === "string" ? result.error_description : `GitHub OAuth 失败：${result.error || "missing_access_token"}`);
    const accessToken = String(result.access_token);
    const login = await githubIdentity(accessToken);
    await writeGithubMcpToken(accessToken);
    await syncGithubMcpToken(details?.apiBase, accessToken);
    callbackResult.complete(true);
    focusRcodeWindow();
    return { ok: true, login, scope: typeof result.scope === "string" ? result.scope : "" };
  } catch (error) {
    callbackResult?.complete(false);
    focusRcodeWindow();
    throw error;
  } finally {
    callbackServer.close();
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
  const method = options.method || "GET";
  const request = { method, headers, body: options.body ? JSON.stringify(options.body) : undefined };
  const retryDelays = [0, 1_500, 4_000];
  const attempts = ["GET", "PUT", "DELETE"].includes(method) ? retryDelays.length : 1;
  let response;
  let networkError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (retryDelays[attempt]) await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    try {
      response = await fetch(`${authApiUrl()}${pathname}`, request);
      break;
    } catch (error) {
      networkError = error;
    }
  }
  if (!response) throw networkError ?? new Error("无法连接 Rcode 账号服务");
  const data = await response.json().catch(() => ({ error: "认证服务返回了无效响应" }));
  if (!response.ok) {
    if (response.status === 401) await clearAuthToken();
    throw new Error(typeof data.error === "string" ? data.error : "认证请求失败");
  }
  return data;
}

async function readLocalWorkAiSyncCandidate(providerId) {
  const url = new URL(`${localAgentApiUrl()}/api/ai/providers/work-sync-candidate`);
  if (providerId) url.searchParams.set("id", providerId);
  const response = await fetch(url, { headers: { "x-agent-token": localApiToken } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.provider) {
    throw new Error(typeof data.error === "string" ? data.error : "无法读取电脑端 AI 接口");
  }
  return data.provider;
}

async function readLocalWorkAiSyncCandidates() {
  const response = await fetch(`${localAgentApiUrl()}/api/ai/providers/work-sync-candidates`, {
    headers: { "x-agent-token": localApiToken }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data?.providers)) {
    throw new Error(typeof data.error === "string" ? data.error : "无法读取电脑端 AI 接口列表");
  }
  return data.providers;
}

async function uploadWorkAiProvider(provider) {
  return authRequest("/v1/work/ai-config", {
    method: "PUT",
    authenticated: true,
    body: {
      providerId: provider.providerId,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      chatCompletionsPath: provider.chatCompletionsPath,
      imageGenerationPath: provider.imageGenerationPath,
      model: provider.model,
      models: provider.models,
      defaultImageModel: provider.defaultImageModel,
      imageModels: provider.imageModels,
      apiKey: provider.apiKey
    }
  });
}

async function syncWorkAiProvider(providerId) {
  const token = await readAuthToken();
  if (!token) throw new Error("请先登录 Rcode 账号再同步 Work 接口");
  const provider = await readLocalWorkAiSyncCandidate(providerId);
  const config = await uploadWorkAiProvider(provider);
  return {
    ok: true,
    provider: { id: provider.providerId, displayName: provider.displayName, model: provider.model },
    config
  };
}

async function syncAllWorkAiProviders() {
  const token = await readAuthToken();
  if (!token) throw new Error("请先登录 Rcode 账号再同步聊天接口");
  const providers = await readLocalWorkAiSyncCandidates();
  if (!providers.length) {
    const config = await authRequest("/v1/work/ai-config", { method: "DELETE", authenticated: true });
    return { ok: true, providerCount: 0, modelCount: 0, providers: [], config };
  }
  let config;
  for (const provider of providers) config = await uploadWorkAiProvider(provider);
  const localIds = new Set(providers.map((provider) => provider.providerId));
  const staleProviders = (Array.isArray(config?.providers) ? config.providers : [])
    .filter((provider) => provider?.id && !localIds.has(provider.id));
  for (const provider of staleProviders) {
    config = await authRequest(`/v1/work/ai-config?providerId=${encodeURIComponent(provider.id)}`, {
      method: "DELETE",
      authenticated: true
    });
  }
  return {
    ok: true,
    providerCount: providers.length,
    modelCount: providers.reduce((total, provider) => total + (Array.isArray(provider.models) ? provider.models.length : 0), 0),
    providers: providers.map((provider) => ({ id: provider.providerId, displayName: provider.displayName, model: provider.model })),
    config
  };
}

function syncAllWorkAiProvidersInBackground() {
  void (async () => {
    const retryDelays = [0, 3_000, 12_000];
    let lastError;
    for (const delay of retryDelays) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await syncAllWorkAiProviders();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    console.warn("Shared AI provider sync unavailable after retries:", lastError instanceof Error ? lastError.message : lastError);
  })();
}

async function remoteDeviceId() {
  try {
    const stored = JSON.parse(await fs.readFile(remoteDevicePath(), "utf8"));
    if (typeof stored.id === "string" && /^[a-zA-Z0-9._:-]+$/.test(stored.id)) return stored.id;
  } catch {
    // A device id is created on first use.
  }
  const id = `desktop:${crypto.randomUUID()}`;
  await fs.mkdir(path.dirname(remoteDevicePath()), { recursive: true });
  await fs.writeFile(remoteDevicePath(), JSON.stringify({ id }, null, 2), { mode: 0o600 });
  return id;
}

function sendRemote(value) {
  if (!remoteSocket || remoteSocket.readyState !== WebSocket.OPEN) return false;
  try {
    remoteSocket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function sendRemoteReliable(value) {
  if (sendRemote(value)) return true;
  remoteReliableOutbox.push(value);
  if (remoteReliableOutbox.length > 100) remoteReliableOutbox.splice(0, remoteReliableOutbox.length - 100);
  return false;
}

function flushRemoteOutbox() {
  while (remoteReliableOutbox.length > 0) {
    if (!sendRemote(remoteReliableOutbox[0])) return;
    remoteReliableOutbox.shift();
  }
}

function publicRemoteWorkspace() {
  return {
    projects: remoteWorkspace.projects.map((project) => ({
      id: project.id,
      name: project.name,
      sessions: project.sessions
    })),
    models: remoteWorkspace.models,
    defaultModel: remoteWorkspace.defaultModel,
    activeProjectId: remoteWorkspace.activeProjectId
  };
}

function stopRemoteAgentConnection(clearWanted = true) {
  if (clearWanted) remoteConnectionWanted = false;
  clearTimeout(remoteReconnectTimer);
  clearInterval(remoteHeartbeatTimer);
  remoteReconnectTimer = undefined;
  remoteHeartbeatTimer = undefined;
  const socket = remoteSocket;
  remoteSocket = undefined;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "desktop disconnect");
}

function scheduleRemoteReconnect(delayMs = 3_000) {
  if (!remoteConnectionWanted) return;
  clearTimeout(remoteReconnectTimer);
  remoteReconnectTimer = setTimeout(() => void startRemoteAgentConnection(), delayMs);
}

function publicRemoteEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return undefined;
  if (event.type === "run_started") {
    return { type: event.type, conversationId: typeof event.conversationId === "string" ? event.conversationId.slice(0, 256) : undefined };
  }
  if (event.type === "workflow_state") {
    return { type: event.type, phase: event.phase, label: String(event.label || "电脑正在处理").slice(0, 240) };
  }
  if (event.type === "text_delta") {
    return { type: event.type, delta: String(event.content || "").slice(0, 8_000) };
  }
  if (event.type === "tool_call") {
    return { type: event.type, toolName: String(event.toolCall?.name || "未知工具").slice(0, 160) };
  }
  if (event.type === "tool_result") {
    return {
      type: event.type,
      toolName: String(event.result?.name || "工具").slice(0, 160),
      ok: event.result?.ok === true,
      summary: typeof event.result?.summary === "string" ? event.result.summary.slice(0, 500) : undefined,
      exitCode: typeof event.result?.exitCode === "number" ? event.result.exitCode : undefined
    };
  }
  if (event.type === "task_plan") {
    const steps = (Array.isArray(event.plan?.steps) ? event.plan.steps : []).slice(0, 30).map((step) => ({
      id: String(step?.id || "").slice(0, 100),
      title: String(step?.title || "任务步骤").slice(0, 240),
      status: step?.status === "completed" || step?.status === "in_progress" ? step.status : "pending"
    }));
    return { type: event.type, summary: String(event.plan?.summary || "任务计划").slice(0, 500), stepCount: steps.length, steps };
  }
  if (event.type === "diff_created") {
    const diffs = Array.isArray(event.diffs) ? event.diffs : [];
    return {
      type: event.type,
      fileCount: diffs.length,
      addedLines: diffs.reduce((total, diff) => total + (Number(diff?.addedLines) || 0), 0),
      removedLines: diffs.reduce((total, diff) => total + (Number(diff?.removedLines) || 0), 0)
    };
  }
  if (event.type === "billing_usage") {
    return {
      type: event.type,
      totalTokens: Number(event.usage?.totalTokens) || 0,
      promptTokens: Number(event.usage?.promptTokens) || 0,
      completionTokens: Number(event.usage?.completionTokens) || 0,
      model: String(event.model || "").slice(0, 160),
      provider: String(event.provider || "").slice(0, 160)
    };
  }
  if (event.type === "context_snapshot") {
    return {
      type: event.type,
      budgetTokens: Number(event.snapshot?.budgetTokens) || 0,
      estimatedTokens: Number(event.snapshot?.estimatedTokens) || 0,
      messageCount: Number(event.snapshot?.messageCount) || 0,
      activeSkillCount: Array.isArray(event.snapshot?.activeSkills) ? event.snapshot.activeSkills.length : 0
    };
  }
  if (event.type === "learning_result") {
    return {
      type: event.type,
      status: String(event.status || "skipped").slice(0, 40),
      recordsSaved: Number(event.recordsSaved) || 0,
      reason: String(event.reason || "").slice(0, 500)
    };
  }
  if (event.type === "permission_decision") {
    return { type: event.type, effect: event.effect, reason: String(event.reason || "权限检查完成").slice(0, 1_000) };
  }
  if (event.type === "approval_required") {
    const approval = Array.isArray(event.approvals) ? event.approvals[0] : undefined;
    if (!approval?.id) return undefined;
    return {
      type: event.type,
      approvalId: String(approval.id).slice(0, 160),
      reason: String(approval.reason || event.answer || "电脑请求执行受保护操作").slice(0, 2_000),
      risk: approval.risk === "high" || approval.risk === "medium" ? approval.risk : "low",
      conversationId: typeof event.conversationId === "string" ? event.conversationId.slice(0, 256) : undefined,
      toolCall: approval.toolCall ? { name: String(approval.toolCall.name || "").slice(0, 160) } : undefined
    };
  }
  if (event.type === "completed") {
    return {
      type: event.type,
      answer: String(event.answer || "任务已完成").slice(0, 12_000),
      conversationId: typeof event.conversationId === "string" ? event.conversationId.slice(0, 256) : undefined
    };
  }
  if (event.type === "error") {
    return { type: event.type, message: String(event.message || "任务执行失败").slice(0, 2_000) };
  }
  return undefined;
}

function isAbortError(error) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|终止/i.test(error.message));
}

async function readRemoteStreamChunk(reader) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("电脑端工具调用长时间没有响应，已自动结束")), REMOTE_STREAM_IDLE_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function consumeLocalAgentStream(command, signal) {
  const payload = command?.payload && typeof command.payload === "object" ? command.payload : {};
  const action = command?.action;
  if (action !== "agent.run" && action !== "agent.approve") throw new Error("不支持的远程指令");
  const requestedProjectId = typeof payload.projectId === "string" ? payload.projectId : "";
  const project = remoteWorkspace.projects.find((item) => item.id === requestedProjectId)
    || remoteWorkspace.projects.find((item) => item.id === remoteWorkspace.activeProjectId)
    || remoteWorkspace.projects[0];
  if (!project?.path) throw new Error("所选项目当前不可用，请在电脑端重新打开项目");
  const requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
  const providerId = typeof payload.providerId === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(payload.providerId.trim())
    ? payload.providerId.trim()
    : undefined;
  const model = requestedModel.slice(0, 160) || remoteWorkspace.defaultModel;
  const mode = ["default", "plan", "workspace_write", "custom", "full_access"].includes(payload.mode)
    ? payload.mode
    : "workspace_write";
  const thinkingMode = payload.thinkingMode === "fast" || payload.thinkingMode === "deep"
    ? payload.thinkingMode
    : "balanced";
  const conversationId = typeof payload.conversationId === "string" && payload.conversationId.length <= 256
    ? payload.conversationId
    : undefined;
  const endpoint = action === "agent.run" ? "/api/agent/run" : "/api/agent/approve";
  const body = action === "agent.run"
    ? {
        prompt: String(payload.prompt || "").slice(0, 8_000),
        mode,
        projectPath: project.path,
        conversationId,
        providerId,
        model,
        thinkingMode
      }
    : {
        approvalId: String(payload.approvalId || "").slice(0, 160),
        allow: payload.allow === true,
        mode,
        projectPath: project.path,
        providerId,
        model,
        thinkingMode
      };
  if (action === "agent.run" && !body.prompt.trim()) throw new Error("远程任务内容为空");
  if (action === "agent.approve" && !body.approvalId) throw new Error("远程审批编号为空");

  const response = await fetch(`${localAgentApiUrl()}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-token": localApiToken },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) {
    const details = await response.json().catch(() => ({}));
    throw new Error(typeof details.error === "string" ? details.error : `本地 Agent 请求失败 (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let summary = "";
  let sawApproval = false;
  let failed = false;
  const processBlock = (block) => {
    const line = block.split(/\r?\n/).find((candidate) => candidate.startsWith("data:"));
    if (!line) return;
    let event;
    try { event = JSON.parse(line.slice(5).trim()); } catch { return; }
    const safeEvent = publicRemoteEvent(event);
    if (!safeEvent) return;
    if (safeEvent.type === "approval_required") sawApproval = true;
    if (safeEvent.type === "error") failed = true;
    if (safeEvent.type === "completed") summary = safeEvent.answer;
    if (safeEvent.type === "error") summary = safeEvent.message;
    if (safeEvent.type === "completed" || safeEvent.type === "error") {
      sendRemoteReliable({ type: "command.event", commandId: command.id, event: safeEvent });
    } else {
      sendRemote({ type: "command.event", commandId: command.id, event: safeEvent });
    }
  };
  try {
    while (true) {
      const { value, done } = await readRemoteStreamChunk(reader);
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) processBlock(block);
      if (done) break;
    }
    if (buffer.trim()) processBlock(buffer);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return { ok: !failed, summary: summary || (sawApproval ? "等待远程审批" : "任务已完成"), sawApproval };
}

async function drainRemoteCommandQueue() {
  if (remoteCommandRunning) return;
  remoteCommandRunning = true;
  try {
    while (remoteCommandQueue.length > 0) {
      const command = remoteCommandQueue.shift();
      if (!command?.id) continue;
      sendRemote({ type: "command.updated", command: { id: command.id, status: "running" } });
      const abortController = new AbortController();
      activeRemoteCommand = command;
      activeRemoteAbortController = abortController;
      try {
        const result = await consumeLocalAgentStream(command, abortController.signal);
        if (!result.sawApproval) {
          const status = result.ok ? "completed" : "failed";
          sendRemoteReliable({ type: "command.updated", command: { id: command.id, status, summary: result.summary } });
          const originCommandId = command.action === "agent.approve" && typeof command.payload?.originCommandId === "string"
            ? command.payload.originCommandId.slice(0, 128)
            : "";
          if (originCommandId) {
            sendRemoteReliable({ type: "command.updated", command: { id: originCommandId, status, summary: result.summary } });
          }
        }
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) continue;
        const message = error instanceof Error ? error.message : "远程任务执行失败";
        sendRemoteReliable({ type: "command.event", commandId: command.id, event: { type: "error", message } });
        sendRemoteReliable({ type: "command.updated", command: { id: command.id, status: "failed", summary: message } });
      } finally {
        if (activeRemoteCommand?.id === command.id) activeRemoteCommand = undefined;
        if (activeRemoteAbortController === abortController) activeRemoteAbortController = undefined;
      }
    }
  } finally {
    remoteCommandRunning = false;
  }
}

function queueRemoteCommand(command) {
  if (!command?.id || receivedRemoteCommandIds.has(command.id)) return;
  receivedRemoteCommandIds.add(command.id);
  if (receivedRemoteCommandIds.size > 500) {
    const oldest = receivedRemoteCommandIds.values().next().value;
    if (oldest) receivedRemoteCommandIds.delete(oldest);
  }
  remoteCommandQueue.push(command);
  void drainRemoteCommandQueue();
}

function stopRemoteCommand(commandId, requestId) {
  for (let index = remoteCommandQueue.length - 1; index >= 0; index--) {
    const queued = remoteCommandQueue[index];
    if (queued?.id === commandId || queued?.requestId === requestId) remoteCommandQueue.splice(index, 1);
  }
  if (activeRemoteCommand?.id === commandId || activeRemoteCommand?.requestId === requestId) {
    activeRemoteAbortController?.abort(new DOMException("已从手机端终止", "AbortError"));
  }
}

async function sendRemoteDeviceUpdate() {
  const serverReady = await waitForServer(1_500);
  const activeProject = remoteWorkspace.projects.find((item) => item.id === remoteWorkspace.activeProjectId)
    || remoteWorkspace.projects[0];
  sendRemote({
    type: "device.announce",
    device: {
      id: await remoteDeviceId(),
      name: os.hostname(),
      platform: process.platform,
      appVersion: app.getVersion(),
      projectName: activeProject?.name,
      workspace: publicRemoteWorkspace(),
      ready: serverReady && remoteWorkspace.projects.some((project) => Boolean(project.path))
    }
  });
}

async function startRemoteAgentConnection() {
  remoteConnectionWanted = true;
  stopRemoteAgentConnection(false);
  const token = await readAuthToken();
  if (!token) {
    remoteConnectionWanted = false;
    return;
  }
  try {
    const serverReady = await waitForServer(4_000);
    const activeProject = remoteWorkspace.projects.find((item) => item.id === remoteWorkspace.activeProjectId)
      || remoteWorkspace.projects[0];
    const ticket = await authRequest("/v1/remote/ticket", {
      method: "POST",
      authenticated: true,
      body: {
        role: "agent",
        device: {
          id: await remoteDeviceId(),
          name: os.hostname(),
          platform: process.platform,
          appVersion: app.getVersion(),
          projectName: activeProject?.name,
          workspace: publicRemoteWorkspace(),
          ready: serverReady && remoteWorkspace.projects.some((project) => Boolean(project.path))
        }
      }
    });
    if (!ticket?.url) throw new Error("远程服务未返回连接地址");
    const socket = new WebSocket(ticket.url);
    remoteSocket = socket;
    socket.addEventListener("open", () => {
      if (remoteSocket !== socket) return;
      clearTimeout(remoteReconnectTimer);
      remoteHeartbeatTimer = setInterval(() => sendRemote({ type: "ping" }), 25_000);
      void sendRemoteDeviceUpdate();
      flushRemoteOutbox();
    });
    socket.addEventListener("message", (message) => {
      if (remoteSocket !== socket) return;
      let body;
      try { body = JSON.parse(String(message.data)); } catch { return; }
      if (
        body?.type === "command.execute"
        && body.command && typeof body.command === "object" && !Array.isArray(body.command)
        && body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ) {
        queueRemoteCommand({ ...body.command, payload: body.payload });
      } else if (body?.type === "command.stop" && (typeof body.commandId === "string" || typeof body.requestId === "string")) {
        stopRemoteCommand(body.commandId, body.requestId);
      } else if (body?.type === "remote.error") {
        console.warn("Remote server rejected a message:", body.error || "unknown error");
      }
    });
    socket.addEventListener("close", () => {
      if (remoteSocket !== socket) return;
      remoteSocket = undefined;
      clearInterval(remoteHeartbeatTimer);
      scheduleRemoteReconnect();
    });
    socket.addEventListener("error", () => {
      if (remoteSocket === socket && socket.readyState < WebSocket.CLOSING) socket.close();
    });
  } catch (error) {
    console.warn("Remote agent connection unavailable:", error instanceof Error ? error.message : error);
    scheduleRemoteReconnect(5_000);
  }
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
      const response = await fetch(`${localAgentApiUrl()}/api/health`, {
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
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        void shell.openExternal(parsedUrl.toString());
      }
    } catch {
      // Ignore malformed and unsupported URLs from rendered model output.
    }
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

  ipcMain.handle("agent:open-external-url", async (_event, rawUrl) => {
    try {
      const parsedUrl = new URL(typeof rawUrl === "string" ? rawUrl : "");
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return { ok: false, error: "仅支持打开 HTTP 或 HTTPS 链接" };
      }
      await shell.openExternal(parsedUrl.toString());
      return { ok: true };
    } catch {
      return { ok: false, error: "链接格式无效" };
    }
  });

  ipcMain.handle("agent:open-local-path", async (_event, details) => {
    const rawPath = typeof details?.path === "string" ? details.path.trim() : "";
    const basePath = typeof details?.basePath === "string" ? details.basePath.trim() : "";
    if (!rawPath || rawPath.includes("\0")) {
      return { ok: false, error: "文件路径无效" };
    }

    try {
      let candidate = rawPath;
      if (candidate.startsWith("file://")) candidate = fileURLToPath(candidate);
      if (candidate === "~") candidate = os.homedir();
      if (candidate.startsWith("~/")) candidate = path.join(os.homedir(), candidate.slice(2));
      if (!path.isAbsolute(candidate)) {
        if (!basePath || !path.isAbsolute(basePath)) {
          return { ok: false, error: "相对路径缺少项目目录" };
        }
        candidate = path.resolve(basePath, candidate);
      }

      await fs.access(candidate);
      const error = await shell.openPath(candidate);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "无法打开文件" };
    }
  });

  ipcMain.handle("agent:get-local-api-token", async () => localApiToken);
  ipcMain.handle("agent:github-mcp-auth-status", async (_event, details) => {
    const token = await readGithubMcpToken();
    if (token) await syncGithubMcpToken(details?.apiBase, token);
    return { authorized: Boolean(token) };
  });
  ipcMain.handle("agent:github-mcp-authorize", authorizeGithubMcp);
  ipcMain.handle("agent:github-mcp-logout", async (_event, details) => {
    await clearGithubMcpToken();
    await syncGithubMcpToken(details?.apiBase, undefined);
    return { ok: true };
  });
  ipcMain.handle("agent:auth-session", async () => {
    const session = await authRequest("/v1/auth/me", { authenticated: true });
    if (session) {
      void startRemoteAgentConnection();
      syncAllWorkAiProvidersInBackground();
    }
    return session;
  });
  ipcMain.handle("agent:auth-login", async (_event, details) => {
    const result = await authRequest("/v1/auth/login", { method: "POST", body: details });
    if (!result?.token) throw new Error("认证服务未返回会话 Token");
    await writeAuthToken(result.token);
    void startRemoteAgentConnection();
    syncAllWorkAiProvidersInBackground();
    return { user: result.user, expiresAt: result.expiresAt };
  });
  ipcMain.handle("agent:auth-register", async (_event, details) => {
    const result = await authRequest("/v1/auth/register", { method: "POST", body: details });
    if (!result?.token) throw new Error("认证服务未返回会话 Token");
    await writeAuthToken(result.token);
    void startRemoteAgentConnection();
    syncAllWorkAiProvidersInBackground();
    return { user: result.user, expiresAt: result.expiresAt };
  });
  ipcMain.handle("agent:auth-logout", async () => {
    try {
      await authRequest("/v1/auth/logout", { method: "POST", authenticated: true });
    } finally {
      stopRemoteAgentConnection();
      await clearAuthToken();
    }
    return { ok: true };
  });
  ipcMain.handle("agent:sync-work-ai", async (_event, details) => {
    const providerId = typeof details?.providerId === "string" ? details.providerId.trim().slice(0, 160) : undefined;
    return syncWorkAiProvider(providerId);
  });
  ipcMain.handle("agent:sync-all-work-ai", async () => syncAllWorkAiProviders());
  ipcMain.handle("agent:remote-update-device", async (_event, details) => {
    const rawProjects = Array.isArray(details?.projects) ? details.projects : [];
    const projects = rawProjects.slice(0, 50).flatMap((rawProject) => {
      const projectPath = typeof rawProject?.path === "string" && path.isAbsolute(rawProject.path)
        ? rawProject.path
        : undefined;
      const id = typeof rawProject?.id === "string" ? rawProject.id.slice(0, 128) : "";
      if (!id || !projectPath) return [];
      const sessions = (Array.isArray(rawProject.sessions) ? rawProject.sessions : []).slice(0, 30).flatMap((rawSession) => {
        const sessionId = typeof rawSession?.id === "string" ? rawSession.id.slice(0, 128) : "";
        if (!sessionId) return [];
        return [{
          id: sessionId,
          title: typeof rawSession.title === "string" && rawSession.title.trim()
            ? rawSession.title.trim().slice(0, 160)
            : "新会话",
          updatedAt: typeof rawSession.updatedAt === "string" ? rawSession.updatedAt.slice(0, 64) : new Date().toISOString(),
          conversationId: typeof rawSession.conversationId === "string" ? rawSession.conversationId.slice(0, 256) : undefined
        }];
      });
      return [{
        id,
        path: projectPath,
        name: typeof rawProject.name === "string" && rawProject.name.trim()
          ? rawProject.name.trim().slice(0, 160)
          : path.basename(projectPath),
        sessions
      }];
    });
    const models = (Array.isArray(details?.models) ? details.models : [])
      .filter((model) => typeof model === "string" && model.trim())
      .map((model) => model.trim().slice(0, 160))
      .slice(0, 60);
    const requestedDefaultModel = typeof details?.defaultModel === "string" ? details.defaultModel.trim().slice(0, 160) : undefined;
    remoteWorkspace = {
      projects,
      models: [...new Set(models)],
      defaultModel: models.includes(requestedDefaultModel) ? requestedDefaultModel : models[0],
      activeProjectId: typeof details?.activeProjectId === "string" ? details.activeProjectId.slice(0, 128) : undefined
    };
    while (JSON.stringify(publicRemoteWorkspace()).length > 40 * 1024) {
      const projectWithSessions = remoteWorkspace.projects
        .filter((project) => project.sessions.length > 0)
        .sort((left, right) => right.sessions.length - left.sessions.length)[0];
      if (projectWithSessions) projectWithSessions.sessions.pop();
      else if (remoteWorkspace.projects.length > 1) remoteWorkspace.projects.pop();
      else break;
    }
    await sendRemoteDeviceUpdate();
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
  void startRemoteAgentConnection();

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
  stopRemoteAgentConnection();
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
