import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { existsSync } from "node:fs";
import { describePermissionMode } from "./permissions";
import { approveToolCallStream, runAgentStream } from "./agent";
import type { PermissionMode, StreamEvent } from "./types";
import { getRuntimeConfig } from "./config";
import type { ThinkingMode } from "./aiProvider";
import { authenticateLocalUser, deleteLocalSession, getLocalAuthStatus, getLocalSession } from "./localDatabase";

dotenv.config();
if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: true });
}

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function parseMode(value: unknown): PermissionMode {
  if (value === "request_approval" || value === "auto_approve" || value === "full_access") {
    return value;
  }
  return getRuntimeConfig().defaultPermissionMode;
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

app.get("/api/health", (_request, response) => {
  const runtimeConfig = getRuntimeConfig();
  response.json({
    ok: true,
    provider: runtimeConfig.providerName,
    model: process.env.AI_MODEL ?? runtimeConfig.provider.defaultModel,
    providerConfigured: Boolean(process.env.AI_API_KEY ?? process.env[runtimeConfig.provider.apiKeyEnv]),
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
  const modes: PermissionMode[] = ["request_approval", "auto_approve", "full_access"];
  response.json({
    defaultMode: runtimeConfig.defaultPermissionMode,
    modes: modes.map((mode) => ({
      id: mode,
      description: describePermissionMode(mode)
    }))
  });
});

app.get("/api/models", (_request, response) => {
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
    }))
  });
});

app.post("/api/agent/run", async (request, response) => {
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

app.post("/api/agent/approve", async (request, response) => {
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

app.listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});
