#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { formatProjectContextSnapshot, getProjectContextSnapshot } from "../projectContext";
import { getMcpTool, listMcpToolDefinitions } from "./registry";
import type { JsonRpcRequest, JsonRpcResponse, McpPromptDefinition, McpPromptResult, McpResourceDefinition, McpServerInfo } from "./types";

const serverInfo: McpServerInfo = {
  name: "rcode-mcp-server",
  version: "0.1.0"
};

const protocolVersion = "2024-11-05";

const resources: McpResourceDefinition[] = [
  {
    uri: "rcode://project/context",
    name: "Rcode Project Context",
    description: "Formatted project context snapshot for the current working directory.",
    mimeType: "text/markdown"
  },
  {
    uri: "rcode://agent/capabilities",
    name: "Rcode Agent Capabilities",
    description: "Summary of built-in Rcode MCP tools and coding-agent capabilities.",
    mimeType: "text/markdown"
  }
];

const prompts: McpPromptDefinition[] = [
  {
    name: "delivery-first-coding-agent",
    description: "Prompt for direct feature delivery, bug fixing, tests, and PR-ready summaries.",
    arguments: [
      { name: "task", description: "Coding task to complete.", required: true },
      { name: "projectPath", description: "Optional absolute project root.", required: false }
    ]
  },
  {
    name: "fix-failing-tests",
    description: "Prompt for parsing test output, fixing root causes, and rerunning validation.",
    arguments: [
      { name: "output", description: "Raw test/typecheck/lint output.", required: true }
    ]
  },
  {
    name: "pr-review-summary",
    description: "Prompt for reviewing a diff and producing a PR-ready summary.",
    arguments: [
      { name: "diff", description: "Unified git diff.", required: true }
    ]
  }
];

function writeMessage(message: JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: unknown }) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcRequest["id"], payload: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result: payload };
}

function error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function getParamsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

function getString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function getPrompt(name: string, args: Record<string, unknown>): McpPromptResult | undefined {
  if (name === "delivery-first-coding-agent") {
    const task = getString(args.task, "Implement the requested change.");
    const projectPath = getString(args.projectPath, "");
    return {
      description: "Delivery-first coding agent prompt",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Act as Rcode, a delivery-first local coding agent.",
              "Focus on directly shipping code, fixing bugs, running validation, reviewing diffs, and preparing PR-ready summaries.",
              projectPath ? `Project root: ${projectPath}` : "Use the current project root if available.",
              "Task:",
              task
            ].join("\n")
          }
        }
      ]
    };
  }

  if (name === "fix-failing-tests") {
    const output = getString(args.output);
    return {
      description: "Fix failing tests prompt",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Parse this failing validation output, identify the root cause, make the smallest safe fix, and rerun the most relevant validation.",
              "Output:",
              output
            ].join("\n")
          }
        }
      ]
    };
  }

  if (name === "pr-review-summary") {
    const diff = getString(args.diff);
    return {
      description: "PR review summary prompt",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Review this diff like a mature coding agent. Focus on correctness, tests, security, maintainability, and PR-ready summary.",
              "Diff:",
              diff
            ].join("\n")
          }
        }
      ]
    };
  }

  return undefined;
}

async function readResource(uri: string) {
  if (uri === "rcode://project/context") {
    const snapshot = getProjectContextSnapshot(process.cwd());
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: formatProjectContextSnapshot(snapshot)
        }
      ]
    };
  }

  if (uri === "rcode://agent/capabilities") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: [
            "# Rcode MCP Capabilities",
            "",
            "Rcode exposes project context, delivery workflow, test parsing, diff review, task branch planning, and context compaction as MCP tools.",
            "",
            "## Tools",
            ...listMcpToolDefinitions().map((tool) => `- ${tool.name}: ${tool.description}`)
          ].join("\n")
        }
      ]
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  if (request.method.startsWith("notifications/")) return undefined;

  try {
    if (request.method === "initialize") {
      return result(request.id, {
        protocolVersion,
        serverInfo,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          logging: {}
        }
      });
    }

    if (request.method === "ping") return result(request.id, {});

    if (request.method === "tools/list") {
      return result(request.id, { tools: listMcpToolDefinitions() });
    }

    if (request.method === "tools/call") {
      const params = getParamsObject(request.params);
      const name = getString(params.name);
      const tool = getMcpTool(name);
      if (!tool) return error(request.id, -32602, `Unknown tool: ${name}`);
      const args = getParamsObject(params.arguments);
      return result(request.id, await tool.handler(args));
    }

    if (request.method === "resources/list") {
      return result(request.id, { resources });
    }

    if (request.method === "resources/read") {
      const params = getParamsObject(request.params);
      return result(request.id, await readResource(getString(params.uri)));
    }

    if (request.method === "prompts/list") {
      return result(request.id, { prompts });
    }

    if (request.method === "prompts/get") {
      const params = getParamsObject(request.params);
      const prompt = getPrompt(getString(params.name), getParamsObject(params.arguments));
      if (!prompt) return error(request.id, -32602, `Unknown prompt: ${getString(params.name)}`);
      return result(request.id, prompt);
    }

    return error(request.id, -32601, `Method not found: ${request.method}`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Unknown MCP server error";
    return error(request.id, -32603, message);
  }
}

function parseJsonLine(line: string): JsonRpcRequest | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as JsonRpcRequest;
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw new Error("Invalid JSON-RPC request");
  }
  return parsed;
}

let buffer = "";

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;

  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);

    void (async () => {
      try {
        const request = parseJsonLine(line);
        if (!request) return;
        const response = await handleRequest(request);
        if (response) writeMessage(response);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Invalid request";
        writeMessage(error(null, -32700, message));
      }
    })();

    newlineIndex = buffer.indexOf("\n");
  }
});

stdin.on("end", () => {
  if (!buffer.trim()) return;
  void (async () => {
    try {
      const request = parseJsonLine(buffer);
      if (!request) return;
      const response = await handleRequest(request);
      if (response) writeMessage(response);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Invalid request";
      writeMessage(error(null, -32700, message));
    }
  })();
});
