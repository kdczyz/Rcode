import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { listMcpServers, saveMcpServer } from "../storage/database";
import type { AgentAttachment, ToolCall, ToolDefinition } from "../shared/types";

interface JsonRpcResponse {
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface StdioSessionEntry {
  signature: string;
  session: StdioMcpSession;
}

interface HttpSessionEntry {
  signature: string;
  sessionId?: string;
  initialized?: Promise<unknown>;
}

const stdioSessions = new Map<string, StdioSessionEntry>();
const httpSessions = new Map<string, HttpSessionEntry>();
const runtimeBearerTokens = new Map<string, string>();
let requestSequence = 0;

function parseShellWords(input: string) {
  const words: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

function normalizeServerId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function setMcpRuntimeBearerToken(serverId: string, token?: string) {
  const key = normalizeServerId(serverId);
  const value = token?.trim();
  if (value) runtimeBearerTokens.set(key, value);
  else runtimeBearerTokens.delete(key);
  httpSessions.delete(serverId);
}

function splitMcpToolName(name: string) {
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return undefined;
  return { serverId: match[1], toolName: match[2] };
}

function asTools(result: unknown): McpTool[] {
  const value = result as { tools?: McpTool[] };
  return Array.isArray(value?.tools) ? value.tools : [];
}

function bearerTokenForServer(serverId: string, envName?: string) {
  const runtimeToken = runtimeBearerTokens.get(normalizeServerId(serverId));
  if (runtimeToken) return runtimeToken;
  if (!envName) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error(`Invalid bearer token environment variable: ${envName}`);
  const token = process.env[envName]?.trim();
  if (!token) throw new Error(`MCP authentication token is not configured. Set ${envName} in .env.local and restart Rcode.`);
  return token;
}

function getHttpSession(serverId: string, url: string, bearerTokenEnvVar?: string) {
  const signature = JSON.stringify([url, bearerTokenEnvVar]);
  let session = httpSessions.get(serverId);
  if (!session || session.signature !== signature) {
    session = { signature };
    httpSessions.set(serverId, session);
  }
  return session;
}

async function postHttp(session: HttpSessionEntry, serverId: string, url: string, bearerTokenEnvVar: string | undefined, method: string, params?: unknown) {
  const token = bearerTokenForServer(serverId, bearerTokenEnvVar);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
  const isNotification = method.startsWith("notifications/");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(isNotification ? {} : { id: `${Date.now()}_${++requestSequence}` }), method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP MCP error ${response.status}: ${text.slice(0, 500)}`);
  const responseSessionId = response.headers.get("mcp-session-id");
  if (responseSessionId) session.sessionId = responseSessionId;
  if (isNotification || !text.trim()) return undefined;
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  const body = dataLine ? dataLine.slice(5).trimStart() : text;
  const parsed = JSON.parse(body) as JsonRpcResponse;
  if (parsed.error) throw new Error(parsed.error.message ?? "MCP JSON-RPC error");
  return parsed.result;
}

async function initializeHttp(session: HttpSessionEntry, serverId: string, url: string, bearerTokenEnvVar?: string, params?: unknown) {
  session.initialized ??= postHttp(session, serverId, url, bearerTokenEnvVar, "initialize", params ?? {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "Rcode", version: "0.1.0" }
  }).then(async (result) => {
    await postHttp(session, serverId, url, bearerTokenEnvVar, "notifications/initialized");
    return result;
  }).catch((error) => {
    session.initialized = undefined;
    session.sessionId = undefined;
    throw error;
  });
  return session.initialized;
}

export async function requestHttpMcp(serverId: string, url: string, bearerTokenEnvVar: string | undefined, method: string, params?: unknown) {
  const session = getHttpSession(serverId, url, bearerTokenEnvVar);
  if (method === "initialize") return initializeHttp(session, serverId, url, bearerTokenEnvVar, params);
  await initializeHttp(session, serverId, url, bearerTokenEnvVar);
  return postHttp(session, serverId, url, bearerTokenEnvVar, method, params);
}

export class StdioMcpSession {
  private child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrTail = "";
  private initialized?: Promise<unknown>;
  private pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(command: string, args: string[], private readonly onClosed: () => void) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-6000);
    });
    this.child.on("error", (error) => this.close(error));
    this.child.on("exit", (code, signal) => {
      this.close(new Error(this.stderrTail.trim() || `MCP server exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
    });
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (parsed.id === undefined) continue;
      const pending = this.pending.get(String(parsed.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(String(parsed.id));
      if (parsed.error) pending.reject(new Error(parsed.error.message ?? "MCP JSON-RPC error"));
      else pending.resolve(parsed.result);
    }
  }

  private close(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClosed();
  }

  request(method: string, params?: unknown, timeoutMs = 30_000) {
    return new Promise<unknown>((resolve, reject) => {
      const id = `${Date.now()}_${++requestSequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  initialize(params?: unknown) {
    this.initialized ??= this.request("initialize", params ?? {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "Rcode", version: "0.1.0" }
    }).then((result) => {
      this.notify("notifications/initialized");
      return result;
    }).catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  dispose() {
    this.child.kill();
  }
}

function getStdioSession(serverId: string, command: string, args: string[]) {
  const signature = JSON.stringify([command, args]);
  const existing = stdioSessions.get(serverId);
  if (existing?.signature === signature) return existing.session;
  const session = new StdioMcpSession(command, args, () => {
    if (stdioSessions.get(serverId)?.session === session) stdioSessions.delete(serverId);
  });
  stdioSessions.set(serverId, { signature, session });
  return session;
}

async function requestStdio(serverId: string, command: string, args: string[], method: string, params?: unknown) {
  const session = getStdioSession(serverId, command, args);
  if (method === "initialize") return session.initialize(params);
  await session.initialize();
  return session.request(method, params);
}

async function requestServer(serverId: string, method: string, params?: unknown) {
  const server = listMcpServers().find((item) => normalizeServerId(item.id) === serverId || item.id === serverId);
  if (!server || !server.enabled) throw new Error(`MCP server is not enabled: ${serverId}`);
  if (server.transport === "http") {
    if (!server.url) throw new Error(`MCP HTTP server ${server.name} is missing url`);
    return requestHttpMcp(server.id, server.url, server.bearerTokenEnvVar, method, params);
  }
  const words = parseShellWords(server.command ?? "");
  const command = words[0];
  const args = [...words.slice(1), ...(server.args ?? [])];
  if (!command) throw new Error(`MCP stdio server ${server.name} is missing command`);
  return requestStdio(server.id, command, args, method, params);
}

export async function testMcpServer(serverId: string) {
  await requestServer(serverId, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "Rcode", version: "0.1.0" }
  });
  const result = await requestServer(serverId, "tools/list");
  const tools = asTools(result);
  const server = listMcpServers().find((item) => normalizeServerId(item.id) === serverId || item.id === serverId);
  if (server) {
    saveMcpServer({
      ...server,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        enabled: true,
        approvalMode: server.defaultApproval
      }))
    });
  }
  return { ok: true, tools };
}

export async function listMcpToolDefinitions(_projectPath?: string): Promise<ToolDefinition[]> {
  const definitions: ToolDefinition[] = [];
  for (const server of listMcpServers().filter((item) => item.enabled)) {
    const serverId = normalizeServerId(server.id);
    let tools: McpTool[] = server.tools?.filter((tool) => tool.enabled !== false).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
    })) ?? [];
    if (tools.length === 0) {
      try {
        const result = await requestServer(serverId, "tools/list");
        tools = asTools(result);
      } catch {
        tools = [];
      }
    }
    for (const tool of tools) {
      const name = `mcp__${serverId}__${tool.name}`;
      definitions.push({
        id: name,
        name,
        description: tool.description || `MCP tool ${tool.name} from ${server.name}`,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        source: "mcp",
        sourceId: server.id,
        risk: "medium",
        requiresSandbox: false,
        defaultApproval: server.defaultApproval,
        approvalMode: server.defaultApproval
      });
    }
  }
  return definitions;
}

export async function listMcpTools(serverId: string) {
  return testMcpServer(serverId);
}

export async function trustMcpServer(serverId: string) {
  const server = listMcpServers().find((item) => normalizeServerId(item.id) === serverId || item.id === serverId);
  if (!server) throw new Error(`MCP server not found: ${serverId}`);
  return saveMcpServer({ ...server, defaultApproval: server.defaultApproval ?? "ask" });
}

function extractMcpToolResult(result: unknown): { ok: boolean; content: string; attachments?: AgentAttachment[] } {
  const payload = result as { content?: Array<Record<string, unknown>>; isError?: boolean };
  if (!Array.isArray(payload?.content)) {
    return { ok: !payload?.isError, content: JSON.stringify(result, null, 2) };
  }
  const textParts: string[] = [];
  const attachments: AgentAttachment[] = [];
  for (const part of payload.content) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "image" && typeof part.data === "string") {
      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      attachments.push({
        id: `mcp_image_${Date.now()}_${attachments.length + 1}`,
        name: `computer-screenshot-${Date.now()}.${mimeType.split("/")[1] || "png"}`,
        mimeType,
        size: Math.floor(part.data.length * 0.75),
        kind: "image",
        dataUrl: `data:${mimeType};base64,${part.data}`
      });
      textParts.push(`[Screenshot attached: ${mimeType}]`);
      continue;
    }
    textParts.push(JSON.stringify(part));
  }
  return {
    ok: !payload.isError,
    content: textParts.join("\n\n") || "MCP tool completed.",
    attachments: attachments.length > 0 ? attachments : undefined
  };
}

export async function executeMcpTool(call: ToolCall, signal?: AbortSignal): Promise<{ ok: boolean; content: string; attachments?: AgentAttachment[] }> {
  const parsed = splitMcpToolName(call.name);
  if (!parsed) throw new Error(`Invalid MCP tool name: ${call.name}`);
  if (signal?.aborted) throw new DOMException("MCP tool call aborted", "AbortError");
  const request = requestServer(parsed.serverId, "tools/call", {
    name: parsed.toolName,
    arguments: call.arguments
  });
  const result = signal ? await new Promise<unknown>((resolve, reject) => {
    const abort = () => reject(new DOMException("MCP tool call aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  }) : await request;
  return extractMcpToolResult(result);
}
