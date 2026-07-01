import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRuntimeConfig } from "./config";
import type { AgentToolName, ToolCall, ToolResult } from "./types";

const execFileAsync = promisify(execFile);

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the local machine.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative path." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write UTF-8 text to a local file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative path." },
          content: { type: "string", description: "The full file content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a web page or API response from the internet.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The HTTP or HTTPS URL to fetch." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a local shell command on the user's computer. Use only when computer control is required.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run through zsh." },
          cwd: { type: "string", description: "Optional working directory." }
        },
        required: ["command"]
      }
    }
  }
] as const;

function getWorkspaceRoot(projectPath?: string): string {
  return projectPath && path.isAbsolute(projectPath) ? projectPath : process.cwd();
}

function resolveSafePath(input: unknown, workspaceRoot: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("path is required");
  }

  return path.isAbsolute(input) ? input : path.resolve(workspaceRoot, input);
}

function getString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }

  return value;
}

export async function executeTool(call: ToolCall, projectPath?: string): Promise<ToolResult> {
  try {
    const runtimeConfig = getRuntimeConfig();
    const workspaceRoot = getWorkspaceRoot(projectPath);
    const toolConfig = runtimeConfig.tools.get(call.name);
    if (toolConfig && !toolConfig.enabled) {
      throw new Error(`Tool ${call.name} is disabled by config/agent.toml`);
    }

    if (call.name === "read_file") {
      const filePath = resolveSafePath(call.arguments.path, workspaceRoot);
      const content = await readFile(filePath, "utf8");

      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: content.slice(0, 12000)
      };
    }

    if (call.name === "write_file") {
      const filePath = resolveSafePath(call.arguments.path, workspaceRoot);
      const content = getString(call.arguments.content, "content");
      await writeFile(filePath, content, "utf8");

      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `Wrote ${content.length} characters to ${filePath}`
      };
    }

    if (call.name === "web_fetch") {
      const url = getString(call.arguments.url, "url");
      const response = await fetch(url);
      const text = await response.text();

      return {
        toolCallId: call.id,
        name: call.name,
        ok: response.ok,
        content: text.slice(0, 12000)
      };
    }

    if (call.name === "run_shell") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) {
        throw new Error("Computer control shell is disabled by config/agent.toml");
      }

      const command = getString(call.arguments.command, "command");
      const blocked = runtimeConfig.computerControl.blockedCommands.find((item) => command.includes(item));
      if (blocked) {
        throw new Error(`Command is blocked by policy: ${blocked}`);
      }

      const cwd = call.arguments.cwd ? resolveSafePath(call.arguments.cwd, workspaceRoot) : workspaceRoot;
      const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
        cwd,
        timeout: 30000,
        maxBuffer: 1024 * 1024
      });

      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: [stdout, stderr].filter(Boolean).join("\n").slice(0, 12000)
      };
    }

    const exhaustive: never = call.name;
    throw new Error(`Unknown tool: ${exhaustive}`);
  } catch (error) {
    return {
      toolCallId: call.id,
      name: call.name as AgentToolName,
      ok: false,
      content: error instanceof Error ? error.message : "Unknown tool error"
    };
  }
}
