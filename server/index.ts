import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describePermissionMode, normalizePermissionMode } from "./permissions";
import { approveToolCallStream, runAgentStream } from "./agent";
import type { PermissionMode, StreamEvent } from "./types";
import { getRuntimeConfig } from "./config";
import type { ThinkingMode } from "./aiProvider";
import {
  authenticateLocalUser,
  deleteLocalSession,
  deleteMcpServer,
  getLocalAuthStatus,
  getConversationById,
  getAgentUsageSummary,
  getLocalSession,
  listAuditEvents,
  listConversations,
  listMemories,
  listMcpServers,
  listPermissionRules,
  saveMemory,
  saveMcpServer,
  savePermissionRules,
  deleteMemory,
  getArtifact,
  type AiProviderConfig,
  type McpServerConfig
} from "./localDatabase";
import {
  activateAiProvider,
  fetchModelsForDraft,
  fetchProviderModels,
  listAiProviders,
  removeAiProvider,
  saveAiProvider,
  testAiProvider
} from "./aiProviderRegistry";
import { getRegisteredTools } from "./tools";
import { defaultPermissionRules } from "./permissionRules";
import { listSkills } from "./skills";
import { listMcpTools, testMcpServer, trustMcpServer } from "./mcpClient";
import { getProjectHookTrust } from "./hooks";
import { listSubagents } from "./subagents";

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
app.use(express.json({ limit: "2mb" }));

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

function parseProjectPath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    process.env.AI_API_KEY ??
    process.env[runtimeConfig.provider.apiKeyEnv]
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

app.get("/api/auth/session", (request, response) => {
  response.json({
    ...getLocalAuthStatus(),
    user: getLocalSession(readBearerToken(request)) ?? null
  });
});

app.post("/api/auth/login", (request, response) => {
  const username = typeof request.body.username === "string" ? request.body.username.trim() : "";
  const password = typeof request.body.password === "string" ? request.body.password : "";
  if (!username || !password) {
    response.status(400).json({ error: "username and password are required" });
    return;
  }

  const result = authenticateLocalUser(username, password);
  if (!result) {
    response.status(401).json({ error: "用户名或密码不正确" });
    return;
  }

  response.json(result);
});

app.post("/api/auth/logout", (request, response) => {
  deleteLocalSession(readBearerToken(request));
  response.json({ ok: true });
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

app.get("/api/agents", requireLocalToken, async (request, response) => {
  response.json({ agents: await listSubagents(parseProjectPath(typeof request.query.projectPath === "string" ? request.query.projectPath : undefined)) });
});

app.get("/api/ai/providers", requireLocalToken, (_request, response) => {
  response.json(listAiProviders());
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

app.post("/api/ai/providers/batch-delete", requireLocalToken, (request, response) => {
  try {
    const { ids } = request.body as { ids: string[] };
    if (!Array.isArray(ids)) throw new Error("ids must be an array");
    for (const id of ids) {
      try { removeAiProvider(String(id)); } catch { /* skip */ }
    }
    response.json({ ok: true, ...listAiProviders() });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "batch delete failed" });
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

app.post("/api/agent/run", requireLocalToken, async (request, response) => {
  const prompt = typeof request.body.prompt === "string" ? request.body.prompt : "";
  if (!prompt.trim()) {
    response.status(400).json({ error: "prompt is required" });
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
      conversationId: typeof request.body.conversationId === "string" ? request.body.conversationId : undefined,
      mode: parseMode(request.body.mode),
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
