import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describePermissionMode, normalizePermissionMode } from "./security/permissions";
import { approveToolCallStream, runAgentStream } from "./agent/agent";
import type { AgentAttachment, PermissionMode, StreamEvent } from "./shared/types";
import { getRuntimeConfig } from "./runtime/config";
import type { ThinkingMode } from "./providers/aiProvider";
import {
  deleteMcpServer,
  getConversationById,
  getAgentUsageSummary,
  listAuditEvents,
  listConversations,
  listMemories,
  listLearningRecords,
  getLatestLearningRun,
  listMcpServers,
  listPermissionRules,
  saveMemory,
  saveLearningRecord,
  saveMcpServer,
  savePermissionRules,
  deleteMemory,
  deleteLearningRecord,
  getArtifact,
  type AiProviderConfig,
  type McpServerConfig
} from "./storage/database";
import {
  activateAiProvider,
  fetchModelsForDraft,
  fetchProviderBalance,
  fetchProviderModels,
  getWorkAiSyncCandidate,
  getWorkAiSyncCandidates,
  listAiProviders,
  removeAiProvider,
  saveAiProvider,
  testAiProvider
} from "./providers/aiProviderRegistry";
import { getRegisteredTools } from "./runtime/tools";
import { defaultPermissionRules } from "./security/permissionRules";
import { listSkills, loadSkillContent } from "./agent/skills";
import { listMcpTools, setMcpRuntimeBearerToken, testMcpServer, trustMcpServer } from "./integrations/mcpClient";
import { getProjectHookTrust } from "./agent/hooks";
import { listSubagents } from "./agent/subagents";
import { managedProcessManager } from "./runtime/processManager";
import { generateImage, generatedImageFilePath, type ImageQuality, type ImageSize } from "./providers/imageProvider";

dotenv.config();
if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: true });
}

const app = express();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const localApiToken = process.env.AGENT_LOCAL_TOKEN;
const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "file://"
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed: ${origin}`));
  }
}));
app.use(express.json({ limit: "24mb" }));

function parseMode(value: unknown): PermissionMode {
  return normalizePermissionMode(value);
}

function parseThinkingMode(value: unknown): ThinkingMode {
  if (value === "fast" || value === "balanced" || value === "deep") {
    return value;
  }
  return "balanced";
}

function parseModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProviderId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(value.trim()) ? value.trim() : undefined;
}

function parseProjectPath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  if (value.length > 8) throw new Error("最多发送 8 个附件");
  let totalBytes = 0;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`附件 ${index + 1} 格式无效`);
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 255) : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim().slice(0, 160) : "application/octet-stream";
    const size = typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, Math.floor(item.size)) : -1;
    const kind = item.kind === "image" ? "image" : item.kind === "file" ? "file" : undefined;
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : undefined;
    const text = typeof item.text === "string" ? item.text : undefined;
    if (!name || !kind || size < 0) throw new Error(`附件 ${index + 1} 缺少必要信息`);
    if (size > 8 * 1024 * 1024) throw new Error(`${name} 超过单文件 8 MB 限制`);
    totalBytes += size;
    if (totalBytes > 16 * 1024 * 1024) throw new Error("附件总大小不能超过 16 MB");
    if (text !== undefined && new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error(`${name} 的文本内容超过 1 MB 限制`);
    if (dataUrl !== undefined && !/^data:[^;,]+;base64,/i.test(dataUrl)) throw new Error(`${name} 的文件数据无效`);
    if (kind === "image" && (!mimeType.startsWith("image/") || !dataUrl)) throw new Error(`${name} 不是有效图片`);
    if (!dataUrl && text === undefined) throw new Error(`${name} 没有可发送的内容`);
    return {
      id: typeof item.id === "string" && item.id ? item.id.slice(0, 120) : randomUUID(),
      name,
      mimeType,
      size,
      kind,
      dataUrl,
      text
    };
  });
}

function writeSse(response: express.Response, event: StreamEvent) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBearerToken(request: express.Request) {
  const header = request.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function hasLocalToken(request: express.Request) {
  if (!localApiToken) return true;
  return readBearerToken(request) === localApiToken || request.header("x-agent-token") === localApiToken;
}

function requireLocalToken(request: express.Request, response: express.Response, next: express.NextFunction) {
  if (hasLocalToken(request)) {
    next();
    return;
  }
  response.status(401).json({ error: "local API token is required" });
}

app.get("/api/health", (_request, response) => {
  const runtimeConfig = getRuntimeConfig();
  const providerConfigured = Boolean(
    runtimeConfig.provider.apiKey ??
    (runtimeConfig.provider.apiKeyEnv
      ? process.env[runtimeConfig.provider.apiKeyEnv]
      : process.env.AI_API_KEY)
  );
  response.json({
    ok: true,
    provider: runtimeConfig.providerName,
    providerDisplayName: runtimeConfig.provider.displayName,
    model: process.env.AI_MODEL ?? runtimeConfig.provider.defaultModel,
    providerConfigured,
    localApiProtected: Boolean(localApiToken),
    executor: "portable-guarded-execution",
    computerControl: runtimeConfig.computerControl
  });
});

app.get("/api/permissions", (_request, response) => {
  const runtimeConfig = getRuntimeConfig();
  const modes: PermissionMode[] = ["default", "plan", "workspace_write", "custom", "full_access"];
  response.json({
    defaultMode: runtimeConfig.defaultPermissionMode,
    modes: modes.map((mode) => ({
      id: mode,
      description: describePermissionMode(mode)
    })),
    rules: [...defaultPermissionRules(), ...listPermissionRules()]
  });
});

app.get("/api/projects", requireLocalToken, (_request, response) => {
  response.json({ conversations: listConversations() });
});

app.get("/api/conversations/:id", requireLocalToken, (request, response) => {
  const conversation = getConversationById(String(request.params.id));
  if (!conversation) {
    response.status(404).json({ error: "conversation not found" });
    return;
  }
  response.json(conversation);
});

app.get("/api/audit", requireLocalToken, (_request, response) => {
  response.json({ events: listAuditEvents(200) });
});

app.get("/api/usage", requireLocalToken, (_request, response) => {
  response.json(getAgentUsageSummary());
});

app.get("/api/settings/permissions", requireLocalToken, (_request, response) => {
  response.json({ rules: [...defaultPermissionRules(), ...listPermissionRules()] });
});

app.post("/api/settings/permissions", requireLocalToken, (request, response) => {
  const rules = Array.isArray(request.body.rules) ? request.body.rules : [];
  savePermissionRules(rules);
  response.json({ rules: [...defaultPermissionRules(), ...listPermissionRules()] });
});

app.get("/api/tools", requireLocalToken, async (request, response) => {
  response.json({ tools: await getRegisteredTools(parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined)) });
});

app.get("/api/skills", requireLocalToken, async (request, response) => {
  response.json({ skills: await listSkills(parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined)) });
});

app.get("/api/skills/content", requireLocalToken, async (request, response) => {
  const projectPath = parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined);
  const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
  const skill = (await listSkills(projectPath)).find((item) => item.path === requestedPath);
  if (!skill) {
    response.status(404).json({ error: "skill not found" });
    return;
  }
  response.json({ skill, content: await loadSkillContent(skill.path, projectPath) });
});

app.get("/api/agents", requireLocalToken, async (request, response) => {
  response.json({ agents: await listSubagents(parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined)) });
});

app.get("/api/ai/providers", requireLocalToken, (_request, response) => {
  response.json(listAiProviders());
});

app.get("/api/ai/providers/work-sync-candidate", requireLocalToken, async (request, response) => {
  try {
    const providerId = typeof request.query.id === "string" ? request.query.id : undefined;
    response.json({ provider: await getWorkAiSyncCandidate(providerId) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "无法读取当前 AI 接口" });
  }
});

app.get("/api/ai/providers/work-sync-candidates", requireLocalToken, async (_request, response) => {
  try {
    response.json({ providers: await getWorkAiSyncCandidates() });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "无法读取电脑端 AI 接口" });
  }
});

app.post("/api/ai/providers", requireLocalToken, (request, response) => {
  try {
    const provider = saveAiProvider(request.body as Partial<AiProviderConfig>);
    response.json({ provider: listAiProviders().providers.find((item) => item.id === provider.id), ...listAiProviders() });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "failed to save AI provider" });
  }
});

app.post("/api/ai/providers/:id/activate", requireLocalToken, (request, response) => {
  try {
    activateAiProvider(String(request.params.id));
    response.json(listAiProviders());
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "failed to activate AI provider" });
  }
});

app.post("/api/ai/providers/:id/test", requireLocalToken, async (request, response) => {
  try {
    response.json(await testAiProvider(String(request.params.id)));
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : "AI provider test failed" });
  }
});

app.get("/api/ai/providers/:id/balance", requireLocalToken, async (request, response) => {
  try {
    response.json(await fetchProviderBalance(String(request.params.id)));
  } catch (error) {
    response.status(400).json({
      status: "unavailable",
      error: error instanceof Error ? error.message : "AI provider balance query failed"
    });
  }
});

app.post("/api/ai/providers/models", requireLocalToken, async (request, response) => {
  try {
    response.json(await fetchModelsForDraft(request.body as Partial<AiProviderConfig>));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "models fetch failed" });
  }
});

app.delete("/api/ai/providers/:id", requireLocalToken, (request, response) => {
  try {
    removeAiProvider(String(request.params.id));
    response.json({ ok: true, ...listAiProviders() });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "failed to delete AI provider" });
  }
});

app.get("/api/mcp/servers", requireLocalToken, (_request, response) => {
  response.json({ servers: listMcpServers() });
});

app.get("/api/mcp/servers/:id/tools", requireLocalToken, async (request, response) => {
  try {
    response.json(await listMcpTools(String(request.params.id)));
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : "MCP tools failed" });
  }
});

app.post("/api/mcp/servers/:id/test", requireLocalToken, async (request, response) => {
  try {
    response.json(await testMcpServer(String(request.params.id)));
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : "MCP test failed" });
  }
});

app.post("/api/mcp/servers/:id/trust", requireLocalToken, async (request, response) => {
  try {
    response.json({ server: await trustMcpServer(String(request.params.id)), servers: listMcpServers() });
  } catch (error) {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : "MCP trust failed" });
  }
});

app.post("/api/mcp/servers", requireLocalToken, (request, response) => {
  const body = request.body as Partial<McpServerConfig>;
  const server: McpServerConfig = {
    id: typeof body.id === "string" && body.id ? body.id : `mcp_${randomUUID()}`,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "MCP Server",
    transport: body.transport === "http" ? "http" : "stdio",
    command: typeof body.command === "string" ? body.command : undefined,
    args: Array.isArray(body.args) ? body.args.map(String) : [],
    url: typeof body.url === "string" ? body.url : undefined,
    bearerTokenEnvVar: typeof body.bearerTokenEnvVar === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(body.bearerTokenEnvVar)
      ? body.bearerTokenEnvVar
      : undefined,
    oauthClientId: typeof body.oauthClientId === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(body.oauthClientId)
      ? body.oauthClientId
      : undefined,
    enabled: body.enabled !== false,
    defaultApproval: body.defaultApproval === "allow" || body.defaultApproval === "deny" ? body.defaultApproval : "ask",
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    tools: Array.isArray(body.tools) ? body.tools : []
  };
  response.json({ server: saveMcpServer(server), servers: listMcpServers() });
});

app.delete("/api/mcp/servers/:id", requireLocalToken, (request, response) => {
  deleteMcpServer(String(request.params.id));
  response.json({ ok: true, servers: listMcpServers() });
});

app.post("/api/mcp/servers/:id/runtime-token", requireLocalToken, (request, response) => {
  const token = typeof request.body.token === "string" ? request.body.token.trim() : "";
  if (token.length > 4096) {
    response.status(400).json({ ok: false, error: "MCP runtime token is too long" });
    return;
  }
  setMcpRuntimeBearerToken(String(request.params.id), token || undefined);
  response.json({ ok: true, configured: Boolean(token) });
});

app.get("/api/memory", requireLocalToken, (request, response) => {
  const projectPath = parseProjectPath(request.query.projectPath) ?? process.cwd();
  response.json({ memories: listMemories(projectPath, 50) });
});

app.post("/api/memory", requireLocalToken, (request, response) => {
  const projectPath = parseProjectPath(request.body.projectPath) ?? process.cwd();
  const kind = typeof request.body.kind === "string" && request.body.kind.trim() ? request.body.kind.trim() : "note";
  const content = typeof request.body.content === "string" ? request.body.content.trim() : "";
  if (!content) {
    response.status(400).json({ error: "content is required" });
    return;
  }
  const importance = typeof request.body.importance === "number" ? request.body.importance : 1;
  response.json({ id: saveMemory(projectPath, kind, content, importance), memories: listMemories(projectPath, 50) });
});

app.delete("/api/memory/:id", requireLocalToken, (request, response) => {
  deleteMemory(String(request.params.id));
  response.json({ ok: true });
});

app.get("/api/learning", requireLocalToken, (request, response) => {
  const projectPath = parseProjectPath(request.query.projectPath) ?? process.cwd();
  response.json({ records: listLearningRecords(projectPath, 250), lastRun: getLatestLearningRun(projectPath) });
});

app.post("/api/learning", requireLocalToken, (request, response) => {
  try {
    const projectPath = parseProjectPath(request.body.projectPath) ?? process.cwd();
    const title = typeof request.body.title === "string" ? request.body.title : "";
    const insight = typeof request.body.insight === "string" ? request.body.insight : "";
    const record = saveLearningRecord({
      projectPath,
      conversationId: typeof request.body.conversationId === "string" ? request.body.conversationId : undefined,
      title,
      insight,
      category: request.body.category,
      evidence: typeof request.body.evidence === "string" ? request.body.evidence : undefined,
      importance: typeof request.body.importance === "number" ? request.body.importance : undefined,
      dedupeKey: typeof request.body.dedupeKey === "string" ? request.body.dedupeKey : undefined,
      source: "manual"
    });
    response.json({ record, records: listLearningRecords(projectPath, 250) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unable to save learning record" });
  }
});

app.delete("/api/learning/:id", requireLocalToken, (request, response) => {
  deleteLearningRecord(String(request.params.id));
  response.json({ ok: true });
});

app.get("/api/artifacts/:id", requireLocalToken, (request, response) => {
  const artifact = getArtifact(String(request.params.id));
  if (!artifact) {
    response.status(404).json({ error: "artifact not found" });
    return;
  }
  response.json({ artifact });
});

app.get("/api/hooks/trust", requireLocalToken, (request, response) => {
  response.json(getProjectHookTrust(parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined)));
});

app.get("/api/processes", requireLocalToken, (request, response) => {
  const projectPath = parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined);
  response.json({ processes: managedProcessManager.list(projectPath) });
});

app.get("/api/processes/:id", requireLocalToken, (request, response) => {
  const tailChars = typeof request.query.tailChars === "string" ? Number(request.query.tailChars) : undefined;
  const process = managedProcessManager.get(String(request.params.id), Number.isFinite(tailChars) ? tailChars : undefined);
  if (!process) {
    response.status(404).json({ error: "managed process not found" });
    return;
  }
  response.json({ process });
});

app.post("/api/processes/:id/input", requireLocalToken, (request, response) => {
  try {
    if (typeof request.body.input !== "string") {
      response.status(400).json({ error: "input is required" });
      return;
    }
    response.json({ process: managedProcessManager.write(String(request.params.id), request.body.input) });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "failed to write process input" });
  }
});

app.post("/api/processes/:id/stop", requireLocalToken, async (request, response) => {
  try {
    response.json({ process: await managedProcessManager.stop(String(request.params.id)) });
  } catch (error) {
    response.status(404).json({ error: error instanceof Error ? error.message : "failed to stop process" });
  }
});

app.get("/api/models", async (_request, response) => {
  try {
    response.json(await fetchProviderModels());
  } catch (error) {
    const runtimeConfig = getRuntimeConfig();
    const models = [
      runtimeConfig.provider.defaultModel,
      ...(runtimeConfig.provider.fallbackModels ?? [])
    ].filter(Boolean);
    response.json({
      source: runtimeConfig.providerName,
      recommendedForAgent: models,
      models: models.map((id) => ({
        id,
        object: "model",
        owned_by: runtimeConfig.providerName
      })),
      error: error instanceof Error ? error.message : "models fetch failed"
    });
  }
});

app.get("/api/images/generated/:fileName", (request, response) => {
  try {
    response.sendFile(
      generatedImageFilePath(String(request.params.fileName)),
      { headers: { "Cache-Control": "private, max-age=31536000, immutable" } },
      (error) => {
        if (error && !response.headersSent) response.status(404).end();
      }
    );
  } catch {
    response.status(404).end();
  }
});

app.post("/api/images/generate", requireLocalToken, async (request, response) => {
  try {
    const prompt = typeof request.body.prompt === "string" ? request.body.prompt : "";
    const size = typeof request.body.size === "string" ? request.body.size as ImageSize : undefined;
    const quality = typeof request.body.quality === "string" ? request.body.quality as ImageQuality : undefined;
    const result = await generateImage({
      prompt,
      providerId: parseProviderId(request.body.providerId),
      model: parseModel(request.body.model),
      size,
      quality,
      count: typeof request.body.count === "number" ? request.body.count : undefined
    });
    response.json({
      ...result,
      attachments: result.attachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment)
    });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "图片生成失败" });
  }
});

app.post("/api/agent/run", requireLocalToken, async (request, response) => {
  const prompt = typeof request.body.prompt === "string" ? request.body.prompt : "";
  let attachments: AgentAttachment[];
  try {
    attachments = parseAttachments(request.body.attachments);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "attachments are invalid" });
    return;
  }
  if (!prompt.trim() && attachments.length === 0) {
    response.status(400).json({ error: "prompt or attachments are required" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const abortController = new AbortController();
  response.on("close", () => abortController.abort());

  try {
    for await (const event of runAgentStream({
      prompt,
      attachments,
      conversationId: typeof request.body.conversationId === "string" ? request.body.conversationId : undefined,
      mode: parseMode(request.body.mode),
      providerId: parseProviderId(request.body.providerId),
      model: parseModel(request.body.model),
      thinkingMode: parseThinkingMode(request.body.thinkingMode),
      projectPath: parseProjectPath(request.body.projectPath),
      signal: abortController.signal
    })) {
      writeSse(response, event);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeSse(response, { type: "error", conversationId: "", message });
  }

  response.end();
});

app.post("/api/agent/approve", requireLocalToken, async (request, response) => {
  const approvalId = typeof request.body.approvalId === "string" ? request.body.approvalId : "";
  if (!approvalId) {
    response.status(400).json({ error: "approvalId is required" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const abortController = new AbortController();
  response.on("close", () => abortController.abort());

  try {
    for await (const event of approveToolCallStream({
      approvalId,
      allow: Boolean(request.body.allow),
      mode: parseMode(request.body.mode),
      providerId: parseProviderId(request.body.providerId),
      model: parseModel(request.body.model),
      thinkingMode: parseThinkingMode(request.body.thinkingMode),
      projectPath: parseProjectPath(request.body.projectPath),
      signal: abortController.signal
    })) {
      writeSse(response, event);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeSse(response, { type: "error", conversationId: "", message });
  }

  response.end();
});

app.listen(port, host, () => {
  console.log(`Agent server listening on http://${host}:${port}`);
});
