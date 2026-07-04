import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRuntimeConfig } from "./config";
import { createPullRequestWithGitHubApi } from "./githubPr";
import { parseTestResult, formatParsedTestResult } from "./testResultParser";
import type { AgentToolName, DiffResult, ToolCall, ToolResult } from "./types";

const execFileAsync = promisify(execFile);

interface ProjectCommandResult {
  ok: boolean;
  output: string;
}

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
      description: "Run a shell command. Use for package installs, git operations, running tests, building projects, or one-off project commands. Do NOT use echo/cat/sed/printf to write files - use write_file instead.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run through zsh. Use non-interactive flags." },
          cwd: { type: "string", description: "Optional working directory. Defaults to project root." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Read git branch, status, and short changed-file summary for the current project. Use before commits, PR summaries, or risky edits.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Optional working directory. Defaults to project root." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Read git diff for the current project. Use after edits to review changes and prepare PR summaries.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Optional working directory. Defaults to project root." },
          staged: { type: "boolean", description: "When true, return staged diff. Otherwise return working tree diff." },
          maxChars: { type: "number", description: "Maximum number of diff characters to return. Defaults to 20000." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run project validation such as typecheck, build, lint, test, or a custom non-interactive command. Prefer this over raw run_shell for validation. The output includes a structured parsed failure summary.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Optional validation command. Defaults to npm run typecheck when package.json has that script, otherwise npm test -- --runInBand." },
          cwd: { type: "string", description: "Optional working directory. Defaults to project root." },
          timeoutMs: { type: "number", description: "Optional timeout in milliseconds. Defaults to 120000." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_pull_request",
      description: "Open a GitHub pull request from the current branch. Prefer native GitHub API when GITHUB_TOKEN or GH_TOKEN is available; otherwise fallback to GitHub CLI.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Pull request title." },
          body: { type: "string", description: "Pull request body with summary, tests, and risk notes." },
          base: { type: "string", description: "Base branch. Defaults to main." },
          cwd: { type: "string", description: "Optional working directory. Defaults to project root." },
          draft: { type: "boolean", description: "Create as draft PR when true." }
        },
        required: ["title", "body"]
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

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getWorkingDirectory(rawCwd: unknown, workspaceRoot: string): string {
  return rawCwd ? resolveSafePath(rawCwd, workspaceRoot) : workspaceRoot;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function extractCommandErrorOutput(error: unknown) {
  if (error && typeof error === "object") {
    const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown };
    const chunks = [candidate.stdout, candidate.stderr, candidate.message]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const output = chunks.join("\n");
    return output || "Command failed without output.";
  }
  return error instanceof Error ? error.message : "Unknown command error";
}

async function runProjectCommand(command: string, cwd: string, timeout = 30000, maxBuffer = 1024 * 1024): Promise<ProjectCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("zsh", ["-lc", command], {
      cwd,
      timeout,
      maxBuffer
    });

    return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n") };
  } catch (error) {
    return { ok: false, output: extractCommandErrorOutput(error) };
  }
}

async function getDefaultTestCommand(cwd: string) {
  const packagePath = path.join(cwd, "package.json");
  if (!existsSync(packagePath)) return "npm test -- --runInBand";

  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    if (packageJson.scripts?.typecheck) return "npm run typecheck";
    if (packageJson.scripts?.test) return "npm test -- --runInBand";
    if (packageJson.scripts?.build) return "npm run build";
  } catch {
    // fall through
  }

  return "npm test -- --runInBand";
}

function truncateToolOutput(content: string, maxChars = 20000) {
  if (content.length <= maxChars) return content;
  const head = content.slice(0, Math.floor(maxChars * 0.7));
  const tail = content.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n\n...[trimmed ${content.length - head.length - tail.length} chars]...\n\n${tail}`;
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

      return { toolCallId: call.id, name: call.name, ok: true, content: content.slice(0, 12000) };
    }

    if (call.name === "write_file") {
      const filePath = resolveSafePath(call.arguments.path, workspaceRoot);
      const content = getString(call.arguments.content, "content");
      let oldContent: string | null = null;
      if (existsSync(filePath)) {
        try { oldContent = await readFile(filePath, "utf8"); } catch { /* ignore */ }
      }
      await writeFile(filePath, content, "utf8");
      const diff = computeDiff(filePath, oldContent, content);
      return { toolCallId: call.id, name: call.name, ok: true, content: `Wrote ${content.length} characters to ${filePath}`, diff };
    }

    if (call.name === "web_fetch") {
      const url = getString(call.arguments.url, "url");
      const response = await fetch(url);
      const text = await response.text();
      return { toolCallId: call.id, name: call.name, ok: response.ok, content: text.slice(0, 12000) };
    }

    if (call.name === "run_shell") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) throw new Error("Computer control shell is disabled by config/agent.toml");
      const command = getString(call.arguments.command, "command");
      const blocked = runtimeConfig.computerControl.blockedCommands.find((item) => command.includes(item));
      if (blocked) throw new Error(`Command is blocked by policy: ${blocked}`);
      const cwd = getWorkingDirectory(call.arguments.cwd, workspaceRoot);
      const result = await runProjectCommand(command, cwd, 30000, 1024 * 1024);
      return { toolCallId: call.id, name: call.name, ok: result.ok, content: truncateToolOutput(`$ ${command}\n\n${result.output}`, 12000) };
    }

    if (call.name === "git_status") {
      const cwd = getWorkingDirectory(call.arguments.cwd, workspaceRoot);
      const result = await runProjectCommand("git branch --show-current && printf '\\n--- status ---\\n' && git status --short && printf '\\n--- upstream ---\\n' && git status --branch --short", cwd, 30000, 1024 * 1024);
      return { toolCallId: call.id, name: call.name, ok: result.ok, content: result.output.slice(0, 12000) };
    }

    if (call.name === "git_diff") {
      const cwd = getWorkingDirectory(call.arguments.cwd, workspaceRoot);
      const staged = call.arguments.staged === true;
      const maxChars = Math.max(2000, Math.min(getOptionalNumber(call.arguments.maxChars) ?? 20000, 60000));
      const result = await runProjectCommand(staged ? "git diff --staged" : "git diff", cwd, 30000, 4 * 1024 * 1024);
      return { toolCallId: call.id, name: call.name, ok: result.ok, content: truncateToolOutput(result.output || "No diff.", maxChars) };
    }

    if (call.name === "run_tests") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) throw new Error("Computer control shell is disabled by config/agent.toml");
      const cwd = getWorkingDirectory(call.arguments.cwd, workspaceRoot);
      const command = getOptionalString(call.arguments.command) ?? await getDefaultTestCommand(cwd);
      const blocked = runtimeConfig.computerControl.blockedCommands.find((item) => command.includes(item));
      if (blocked) throw new Error(`Command is blocked by policy: ${blocked}`);
      const timeout = Math.max(10000, Math.min(getOptionalNumber(call.arguments.timeoutMs) ?? 120000, 10 * 60 * 1000));
      const result = await runProjectCommand(command, cwd, timeout, 4 * 1024 * 1024);
      const parsed = parseTestResult(command, result.ok, result.output);
      const structuredSummary = formatParsedTestResult(parsed);
      return { toolCallId: call.id, name: call.name, ok: result.ok, content: truncateToolOutput(`${structuredSummary}\n\n## Raw Output\n$ ${command}\n\n${result.output}`, 26000) };
    }

    if (call.name === "open_pull_request") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) throw new Error("Computer control shell is disabled by config/agent.toml");
      const cwd = getWorkingDirectory(call.arguments.cwd, workspaceRoot);
      const title = getString(call.arguments.title, "title");
      const body = getString(call.arguments.body, "body");
      const base = getOptionalString(call.arguments.base) ?? "main";
      const draft = call.arguments.draft === true;

      const nativeResult = await createPullRequestWithGitHubApi({ cwd, title, body, base, draft });
      if (nativeResult) {
        return { toolCallId: call.id, name: call.name, ok: nativeResult.ok, content: truncateToolOutput(nativeResult.output, 12000) };
      }

      const command = ["gh pr create", "--title", shellQuote(title), "--body", shellQuote(body), "--base", shellQuote(base), draft ? "--draft" : ""].filter(Boolean).join(" ");
      const result = await runProjectCommand(command, cwd, 60000, 1024 * 1024);
      return { toolCallId: call.id, name: call.name, ok: result.ok, content: truncateToolOutput(`$ ${command}\n\n${result.output}`, 12000) };
    }

    const exhaustive: never = call.name;
    throw new Error(`Unknown tool: ${exhaustive}`);
  } catch (error) {
    return { toolCallId: call.id, name: call.name as AgentToolName, ok: false, content: error instanceof Error ? error.message : "Unknown tool error" };
  }
}

function computeDiff(filePath: string, oldContent: string | null, newContent: string): DiffResult {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent.split("\n");
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

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
