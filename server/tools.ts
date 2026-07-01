import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRuntimeConfig } from "./config";
import type { AgentToolName, DiffResult, ToolCall, ToolResult } from "./types";

const execFileAsync = promisify(execFile);

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's content from the local filesystem. Always read a file before editing it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or project-relative path to the file." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a file with its COMPLETE content in a single call. Always provide the full file content, not fragments. This is the ONLY way to create or modify files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or project-relative path to the file." },
          content: { type: "string", description: "The complete file content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch content from a URL. Use for documentation, API references, or checking package info.",
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
      description: "Run a shell command. Use ONLY for: npm install, git operations, running tests, building projects. Do NOT use echo/cat/sed/printf to write files - use write_file instead.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run through zsh. Use non-interactive flags." },
          cwd: { type: "string", description: "Optional working directory. Defaults to project root." }
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

      // 读取旧文件内容用于生成 diff
      let oldContent: string | null = null;
      if (existsSync(filePath)) {
        try {
          oldContent = await readFile(filePath, "utf8");
        } catch { /* ignore */ }
      }

      await writeFile(filePath, content, "utf8");

      const diff = computeDiff(filePath, oldContent, content);

      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `Wrote ${content.length} characters to ${filePath}`,
        diff
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

/** 基于 LCS 的简单行级 diff，生成 unified diff 行 */
function computeDiff(filePath: string, oldContent: string | null, newContent: string): DiffResult {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent.split("\n");

  // LCS 算法
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const lines: DiffResult["lines"] = [];
  let addedLines = 0;
  let removedLines = 0;
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      lines.unshift({ type: "same", content: oldLines[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      lines.unshift({ type: "add", content: newLines[j - 1], newLine: j });
      addedLines++;
      j--;
    } else {
      lines.unshift({ type: "remove", content: oldLines[i - 1], oldLine: i });
      removedLines++;
      i--;
    }
  }

  return { filePath, oldContent, newContent, lines, addedLines, removedLines };
}
