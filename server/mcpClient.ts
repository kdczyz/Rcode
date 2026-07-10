import { spawn } from "node:child_process";
import { listMcpServers, saveMcpServer } from "./localDatabase";
import type { ToolCall, ToolDefinition } from "./types";

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

function splitMcpToolName(name: string) {
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return undefined;
  return { serverId: match[1], toolName: match[2] };
}

function asTools(result: unknown): McpTool[] {
  const value = result as { tools?: McpTool[] };
  return Array.isArray(value?.tools) ? value.tools : [];
}

async function requestHttp(url: string, method: string, params?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}`, method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP MCP error ${response.status}: ${text.slice(0, 500)}`);
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const body = dataLine ? dataLine.slice(6) : text;
  const parsed = JSON.parse(body) as JsonRpcResponse;
  if (parsed.error) throw new Error(parsed.error.message ?? "MCP JSON-RPC error");
  return parsed.result;
}

async function requestStdio(command: string, args: string[], method: string, params?: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP stdio request timed out: ${method}`));
    }, 10000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id !== undefined) {
            clearTimeout(timer);
            child.kill();
            if (parsed.error) reject(new Error(parsed.error.message ?? "MCP JSON-RPC error"));
            else resolve(parsed.result);
            return;
          }
        } catch {
          // Wait for a complete line.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== 0 && !stdout.trim()) {
        clearTimeout(timer);
        reject(new Error(stderr.trim() || `MCP server exited with ${code}`));
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}`, method, params }) + "\n");
  });
}

async function requestServer(serverId: string, method: string, params?: unknown) {
  const server = listMcpServers().find((item) => normalizeServerId(item.id) === serverId || item.id === serverId);
  if (!server || !server.enabled) throw new Error(`MCP server is not enabled: ${serverId}`);
  if (server.transport === "http") {
    if (!server.url) throw new Error(`MCP HTTP server ${server.name} is missing url`);
    return requestHttp(server.url, method, params);
  }
  const words = parseShellWords(server.command ?? "");
  const command = words[0];
  const args = [...words.slice(1), ...(server.args ?? [])];
  if (!command) throw new Error(`MCP stdio server ${server.name} is missing command`);
  return requestStdio(command, args, method, params);
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
    saveMcpServer({ ...server, tools: tools.map((tool) => ({ name: tool.name, description: tool.description, enabled: true, approvalMode: server.defaultApproval })) });
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
      inputSchema: { type: "object", properties: {} }
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

export async function executeMcpTool(call: ToolCall): Promise<{ ok: boolean; content: string }> {
  const parsed = splitMcpToolName(call.name);
  if (!parsed) throw new Error(`Invalid MCP tool name: ${call.name}`);
  const result = await requestServer(parsed.serverId, "tools/call", {
    name: parsed.toolName,
    arguments: call.arguments
  });
  const content = JSON.stringify(result, null, 2);
  return { ok: true, content };
}
