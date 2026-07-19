import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getRuntimeConfig } from "./config";
import { recordAuditEvent, saveArtifact, saveLearningRecord, type LearningRecordCategory } from "../storage/database";
import { portableExecutor } from "./executor";
import { managedProcessManager } from "./processManager";
import { executeMcpTool, listMcpToolDefinitions } from "../integrations/mcpClient";
import { generateImage, type ImageQuality, type ImageSize } from "../providers/imageProvider";
import { assertNotSymlinkEscape, assertPathInsideWorkspace, getWorkspaceRoot, resolveWorkspacePath, sandboxPolicyName } from "../security/sandbox";
import type { AgentToolName, BuiltinToolName, DiffResult, ExecutorResult, ManagedProcessSnapshot, PermissionMode, ToolCall, ToolDefinition, ToolResult } from "../shared/types";

const ignoredWorkspaceEntries = new Set([
  ".DS_Store",
  ".cache",
  ".git",
  ".uploads",
  ".workbuddy",
  "build",
  "data",
  "dist",
  "dist-server",
  "dist-server-bundle",
  "node_modules",
  "release"
]);

const inputSchemas: Record<BuiltinToolName, Record<string, unknown>> = {
  read_file: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute or project-relative path to the file." } },
    required: ["path"]
  },
  write_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or project-relative path to the file." },
      content: { type: "string", description: "Complete file content. Prefer apply_patch for existing files." }
    },
    required: ["path", "content"]
  },
  list_files: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list. Defaults to project root." },
      maxResults: { type: "number", description: "Maximum files to return." }
    }
  },
  search_text: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text or regular expression to search for." },
      path: { type: "string", description: "Directory to search. Defaults to project root." },
      maxResults: { type: "number", description: "Maximum matches to return." }
    },
    required: ["query"]
  },
  inspect_tree: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to inspect. Defaults to project root." },
      depth: { type: "number", description: "Maximum depth. Defaults to 2." }
    }
  },
  project_diagnostics: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Project directory inside the workspace. Defaults to project root." },
      kind: { type: "string", enum: ["typecheck", "lint", "test", "build", "all"], description: "Diagnostic task to run. Defaults to typecheck." }
    }
  },
  generate_image: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Detailed visual description for the image model." },
      model: { type: "string", description: "Optional configured image model. Uses the provider default when omitted." },
      size: { type: "string", enum: ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "2160x3840", "3840x2160"] },
      quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
      count: { type: "number", minimum: 1, maximum: 4 }
    },
    required: ["prompt"]
  },
  record_learning: {
    type: "object",
    properties: {
      title: { type: "string", description: "Specific, concise title for the reusable lesson." },
      insight: { type: "string", description: "Self-contained and actionable lesson for future work." },
      category: { type: "string", enum: ["preference", "project", "pattern", "bugfix", "workflow"], description: "Type of learned knowledge." },
      evidence: { type: "string", description: "How the lesson was verified, such as a test, file, or observed behavior." },
      importance: { type: "number", minimum: 1, maximum: 5, description: "Future impact from 1 (minor) to 5 (critical)." },
      dedupeKey: { type: "string", description: "Stable concept key used to update an equivalent lesson instead of creating a duplicate." }
    },
    required: ["title", "insight", "category"]
  },
  apply_patch: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to patch." },
      oldText: { type: "string", description: "Exact text that must exist before patching." },
      newText: { type: "string", description: "Replacement text." },
      patch: { type: "string", description: "Unified diff patch. Preferred for multi-hunk edits." }
    }
  },
  web_fetch: {
    type: "object",
    properties: { url: { type: "string", description: "The HTTP or HTTPS URL to fetch." } },
    required: ["url"]
  },
  run_shell: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run through zsh. Use non-interactive flags." },
      cwd: { type: "string", description: "Optional working directory. Defaults to project root." },
      secretRefs: { type: "array", items: { type: "string" }, description: "Allowlisted environment-variable names to inject without exposing their values to the model." }
    },
    required: ["command"]
  },
  start_process: {
    type: "object",
    properties: {
      command: { type: "string", description: "Long-running command to start. Do not add &, nohup, or output redirection." },
      cwd: { type: "string", description: "Optional working directory. Defaults to project root." },
      label: { type: "string", description: "Short user-facing label, such as Vue dev server." },
      startupWaitMs: { type: "number", description: "Milliseconds to collect startup output before returning (0-3000)." },
      secretRefs: { type: "array", items: { type: "string" }, description: "Allowlisted environment-variable names to inject without exposing their values to the model." }
    },
    required: ["command"]
  },
  read_process: {
    type: "object",
    properties: {
      processId: { type: "string", description: "Managed process session ID." },
      tailChars: { type: "number", description: "Number of recent output characters to return." }
    },
    required: ["processId"]
  },
  write_process: {
    type: "object",
    properties: {
      processId: { type: "string", description: "Managed process session ID." },
      input: { type: "string", description: "Input to write to the process stdin. Include a newline when needed." }
    },
    required: ["processId", "input"]
  },
  stop_process: {
    type: "object",
    properties: { processId: { type: "string", description: "Managed process session ID." } },
    required: ["processId"]
  },
  list_processes: {
    type: "object",
    properties: {}
  },
  docker_compose: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["config", "ps", "logs", "build", "pull", "up", "down", "restart"], description: "Compose action. Read-only actions run automatically; mutations require approval." },
      cwd: { type: "string", description: "Directory containing the Compose file." },
      services: { type: "array", items: { type: "string" }, description: "Optional service names." },
      tail: { type: "number", description: "Log lines for the logs action (1-2000)." }
    },
    required: ["action"]
  },
  sqlite_query: {
    type: "object",
    properties: {
      path: { type: "string", description: "SQLite database file inside the workspace." },
      query: { type: "string", description: "SQL statement. Read-only queries run automatically; mutations require approval." }
    },
    required: ["path", "query"]
  },
  git_status: {
    type: "object",
    properties: { cwd: { type: "string", description: "Optional git worktree path. Defaults to project root." } }
  },
  git_diff: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Optional git worktree path. Defaults to project root." },
      staged: { type: "boolean", description: "Show staged diff." }
    }
  },
  git_branch: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Optional git worktree path. Defaults to project root." },
      name: { type: "string", description: "Branch name to create or switch to." },
      create: { type: "boolean", description: "Create the branch before switching." }
    },
    required: ["name"]
  },
  git_stage: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Optional git worktree path. Defaults to project root." },
      paths: { type: "array", items: { type: "string" }, description: "Workspace-relative paths to stage." }
    },
    required: ["paths"]
  },
  git_commit: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Optional git worktree path. Defaults to project root." },
      message: { type: "string", description: "Commit message." }
    },
    required: ["message"]
  },
  git_push: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Optional git worktree path. Defaults to project root." },
      remote: { type: "string", description: "Remote name. Defaults to origin." },
      branch: { type: "string", description: "Optional branch name. Defaults to the current branch." },
      setUpstream: { type: "boolean", description: "Set upstream tracking for the branch." }
    }
  }
};

export const registeredTools: ToolDefinition[] = [
  { id: "read_file", name: "read_file", description: "Read a file from the workspace after canonical path checks.", inputSchema: inputSchemas.read_file, source: "builtin", risk: "medium", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "write_file", name: "write_file", description: "Create or overwrite a file with complete content. Prefer apply_patch for edits.", inputSchema: inputSchemas.write_file, source: "builtin", risk: "high", requiresSandbox: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "list_files", name: "list_files", description: "List files under a workspace directory while ignoring build artifacts.", inputSchema: inputSchemas.list_files, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "search_text", name: "search_text", description: "Search text in workspace files while ignoring build artifacts.", inputSchema: inputSchemas.search_text, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "inspect_tree", name: "inspect_tree", description: "Inspect the workspace directory tree.", inputSchema: inputSchemas.inspect_tree, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "project_diagnostics", name: "project_diagnostics", description: "Run configured project typecheck, lint, test, or build diagnostics inside the workspace.", inputSchema: inputSchemas.project_diagnostics, source: "builtin", risk: "low", requiresSandbox: true, requiresExecutor: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "generate_image", name: "generate_image", description: "Generate images when the user requests an actual image. Uses the selected provider's automatically detected image model; omit model unless the user explicitly chooses one.", inputSchema: inputSchemas.generate_image, source: "builtin", risk: "high", requiresSandbox: false, defaultApproval: "allow", approvalMode: "allow" },
  { id: "record_learning", name: "record_learning", description: "Save a verified reusable lesson to this project's learning records. Never store credentials, personal data, raw logs, or unverified guesses.", inputSchema: inputSchemas.record_learning, source: "builtin", risk: "low", requiresSandbox: false, defaultApproval: "allow", approvalMode: "allow" },
  { id: "apply_patch", name: "apply_patch", description: "Patch an existing file using unified diff or exact oldText/newText replacement.", inputSchema: inputSchemas.apply_patch, source: "builtin", risk: "high", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "web_fetch", name: "web_fetch", description: "Fetch documentation or API references from a URL.", inputSchema: inputSchemas.web_fetch, source: "builtin", risk: "medium", requiresSandbox: false, defaultApproval: "ask", approvalMode: "ask" },
  { id: "run_shell", name: "run_shell", description: "Run a shell command through portable guarded execution.", inputSchema: inputSchemas.run_shell, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "start_process", name: "start_process", description: "Start a guarded long-running process session for dev servers, watchers, and similar commands. Returns immediately with a process ID and startup output.", inputSchema: inputSchemas.start_process, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "read_process", name: "read_process", description: "Read the current state and recent output of a managed process session.", inputSchema: inputSchemas.read_process, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "write_process", name: "write_process", description: "Write input to a running managed process session.", inputSchema: inputSchemas.write_process, source: "builtin", risk: "medium", requiresSandbox: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "stop_process", name: "stop_process", description: "Stop a managed process session and its child process tree.", inputSchema: inputSchemas.stop_process, source: "builtin", risk: "medium", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "list_processes", name: "list_processes", description: "List managed process sessions for the current project.", inputSchema: inputSchemas.list_processes, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "docker_compose", name: "docker_compose", description: "Inspect or control Docker Compose with structured arguments and approval for mutations.", inputSchema: inputSchemas.docker_compose, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "sqlite_query", name: "sqlite_query", description: "Query a workspace SQLite database; reads are automatic and mutations require approval.", inputSchema: inputSchemas.sqlite_query, source: "builtin", risk: "high", requiresSandbox: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "git_status", name: "git_status", description: "Show git status for the workspace.", inputSchema: inputSchemas.git_status, source: "builtin", risk: "low", requiresSandbox: true, requiresExecutor: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "git_diff", name: "git_diff", description: "Show git diff for the workspace.", inputSchema: inputSchemas.git_diff, source: "builtin", risk: "low", requiresSandbox: true, requiresExecutor: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "git_branch", name: "git_branch", description: "Create or switch a git branch in the workspace.", inputSchema: inputSchemas.git_branch, source: "builtin", risk: "medium", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "git_stage", name: "git_stage", description: "Stage selected workspace paths for commit.", inputSchema: inputSchemas.git_stage, source: "builtin", risk: "medium", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "git_commit", name: "git_commit", description: "Create a git commit with the staged changes.", inputSchema: inputSchemas.git_commit, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "git_push", name: "git_push", description: "Push a branch to a Git remote after explicit approval.", inputSchema: inputSchemas.git_push, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" }
];

export async function getRegisteredTools(projectPath?: string): Promise<ToolDefinition[]> {
  return [...registeredTools, ...(await listMcpToolDefinitions(projectPath))];
}

export async function getToolDefinitions(projectPath?: string) {
  const tools = await getRegisteredTools(projectPath);
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  })) as Array<{ type: "function"; function: { name: AgentToolName; description: string; parameters: Record<string, unknown> } }>;
}

function getString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}

function getNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface ToolExecutionContext {
  conversationId?: string;
  permissionEffect?: string;
  permissionReason?: string;
  permissionMode?: PermissionMode;
  providerId?: string;
}

async function resolveReadableToolPath(input: unknown, projectPath: string | undefined, allowOutsideWorkspace: boolean) {
  return allowOutsideWorkspace
    ? resolveWorkspacePath(input, projectPath)
    : assertPathInsideWorkspace(input, projectPath);
}

async function resolveWritableToolPath(input: unknown, projectPath: string | undefined, allowOutsideWorkspace: boolean) {
  return allowOutsideWorkspace
    ? resolveWorkspacePath(input, projectPath)
    : assertNotSymlinkEscape(input, projectPath);
}

function formatProcess(process: ManagedProcessSnapshot) {
  const lifecycle = [
    `Process: ${process.label ?? process.id}`,
    `ID: ${process.id}`,
    `Status: ${process.status}`,
    process.pid ? `PID: ${process.pid}` : "",
    process.exitCode !== undefined ? `Exit code: ${process.exitCode}` : "",
    `CWD: ${process.cwd}`
  ].filter(Boolean).join("\n");
  return process.output ? `${lifecycle}\n\nOutput:\n${process.output}` : lifecycle;
}

async function walkFiles(root: string, maxResults: number, includeContentSearch?: { query: RegExp }) {
  const results: string[] = [];
  const matches: string[] = [];

  async function visit(current: string) {
    if (results.length >= maxResults && !includeContentSearch) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredWorkspaceEntries.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
        if (includeContentSearch && matches.length < maxResults) {
          try {
            const text = await readFile(fullPath, "utf8");
            const lines = text.split("\n");
            lines.forEach((line, index) => {
              if (matches.length < maxResults && includeContentSearch.query.test(line)) {
                matches.push(`${fullPath}:${index + 1}: ${line.slice(0, 240)}`);
              }
            });
          } catch {
            // Binary or unreadable files are skipped.
          }
        }
      }
      if ((includeContentSearch ? matches.length : results.length) >= maxResults) return;
    }
  }

  await visit(root);
  return includeContentSearch ? matches : results.slice(0, maxResults);
}

async function inspectTree(root: string, depth: number) {
  const lines: string[] = [];
  async function visit(current: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth) return;
    const entries = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => !ignoredWorkspaceEntries.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries.slice(0, 80)) {
      lines.push(`${prefix}${entry.isDirectory() ? "▸" : "-"} ${entry.name}`);
      if (entry.isDirectory()) await visit(path.join(current, entry.name), currentDepth + 1, `${prefix}  `);
    }
  }
  await visit(root, 1, "");
  return lines.join("\n");
}

function summarizeWithArtifacts(
  rawContent: string,
  context?: { conversationId?: string },
  options?: { stdout?: string; stderr?: string }
) {
  const artifacts: Array<{ id: string; label: string; kind: string }> = [];
  let stdoutArtifactId: string | undefined;
  let stderrArtifactId: string | undefined;

  if (options?.stdout && options.stdout.length > 12000) {
    const artifact = saveArtifact({ conversationId: context?.conversationId, kind: "stdout", label: "Command stdout", content: options.stdout });
    artifacts.push(artifact);
    stdoutArtifactId = artifact.id;
  }
  if (options?.stderr && options.stderr.length > 12000) {
    const artifact = saveArtifact({ conversationId: context?.conversationId, kind: "stderr", label: "Command stderr", content: options.stderr });
    artifacts.push(artifact);
    stderrArtifactId = artifact.id;
  }
  if (rawContent.length > 12000 && artifacts.length === 0) {
    artifacts.push(saveArtifact({ conversationId: context?.conversationId, kind: "tool_output", label: "Tool output", content: rawContent }));
  }

  const artifactText = artifacts.length > 0
    ? `\n\n[Full output saved as artifacts: ${artifacts.map((artifact) => artifact.id).join(", ")}]`
    : "";
  return {
    content: `${rawContent.slice(0, 12000)}${artifactText}`,
    summary: rawContent.slice(0, 1000),
    artifacts,
    stdoutArtifactId,
    stderrArtifactId
  };
}

function executorOutput(result: ExecutorResult) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function isReadOnlySql(query: string) {
  return /^(select|pragma\b(?![\s\S]*=)|explain|with\b[\s\S]*\bselect\b)/i.test(query.trim());
}

async function diagnosticCommand(cwd: string, kind: string) {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error("project_diagnostics currently requires a package.json in the selected directory");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};
  const requested = kind === "all" ? ["typecheck", "lint", "test", "build"] : [kind];
  const available = requested.filter((name) => typeof scripts[name] === "string");
  if (available.length === 0) {
    throw new Error(`No matching package script found for diagnostics: ${requested.join(", ")}`);
  }
  return available.map((name) => `npm run ${name}`).join(" && ");
}

function getStringArray(value: unknown, field: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return value as string[];
}

function buildExecutorToolResult(
  call: ToolCall,
  executorResult: ExecutorResult,
  context?: { conversationId?: string }
): ToolResult {
  const rawContent = executorOutput(executorResult);
  const summarized = summarizeWithArtifacts(rawContent, context, { stdout: executorResult.stdout, stderr: executorResult.stderr });
  return {
    toolCallId: call.id,
    name: call.name,
    ok: executorResult.ok,
    exitCode: executorResult.exitCode,
    content: summarized.content || executorResult.blockedReason || "",
    summary: summarized.summary,
    artifacts: summarized.artifacts,
    stdoutArtifactId: summarized.stdoutArtifactId,
    stderrArtifactId: summarized.stderrArtifactId
  };
}

export async function executeTool(call: ToolCall, projectPath?: string, context?: ToolExecutionContext): Promise<ToolResult> {
  const startedAt = Date.now();
  const allowOutsideWorkspace = context?.permissionMode === "full_access";
  let auditEventId: string | undefined;
  let exitCode: number | undefined;
  let outputSummary = "";

  try {
    const runtimeConfig = getRuntimeConfig();
    const toolConfig = runtimeConfig.tools.get(call.name);
    if (toolConfig && !toolConfig.enabled) {
      throw new Error(`Tool ${call.name} is disabled by config/agent.toml`);
    }

    let result: ToolResult;

    let executorResult: ExecutorResult | undefined;

    if (call.name.startsWith("mcp__native-devtools__")) {
      if (!runtimeConfig.computerControl.enabled) throw new Error("Computer control is disabled by config/agent.toml");
      const nativeToolName = call.name.slice("mcp__native-devtools__".length);
      const screenshotTools = new Set(["take_screenshot", "find_text", "find_image", "load_image", "start_recording"]);
      const accessibilityTools = new Set(["take_ax_snapshot", "probe_app", "element_at_point", "ax_click", "ax_set_value", "ax_select"]);
      const inputTools = new Set(["click", "move_mouse", "drag", "scroll", "type_text", "press_key"]);
      const appTools = new Set(["list_windows", "list_apps", "focus_window", "launch_app", "quit_app"]);
      if (screenshotTools.has(nativeToolName) && !runtimeConfig.computerControl.screenshot) throw new Error("Computer screenshots are disabled by config/agent.toml");
      if (accessibilityTools.has(nativeToolName) && !runtimeConfig.computerControl.accessibility) throw new Error("Accessibility control is disabled by config/agent.toml");
      if (inputTools.has(nativeToolName) && !runtimeConfig.computerControl.keyboardMouse) throw new Error("Mouse and keyboard control is disabled by config/agent.toml");
      if (appTools.has(nativeToolName) && !runtimeConfig.computerControl.openApp) throw new Error("Application control is disabled by config/agent.toml");
    }

    if (call.name.startsWith("mcp__")) {
      const mcpResult = await executeMcpTool(call);
      const summarized = summarizeWithArtifacts(mcpResult.content, context);
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: mcpResult.ok,
        content: summarized.content,
        summary: summarized.summary,
        artifacts: summarized.artifacts,
        attachments: mcpResult.attachments
      };
    } else if (call.name === "read_file") {
      const filePath = await resolveReadableToolPath(call.arguments.path, projectPath, allowOutsideWorkspace);
      const content = await readFile(filePath.canonicalPath, "utf8");
      result = { toolCallId: call.id, name: call.name, ok: true, content: content.slice(0, 12000) };
    } else if (call.name === "write_file") {
      const filePath = await resolveWritableToolPath(call.arguments.path, projectPath, allowOutsideWorkspace);
      const content = getString(call.arguments.content, "content");
      let oldContent: string | null = null;
      if (existsSync(filePath.canonicalPath)) oldContent = await readFile(filePath.canonicalPath, "utf8");
      await mkdir(path.dirname(filePath.canonicalPath), { recursive: true });
      await writeFile(filePath.canonicalPath, content, "utf8");
      const diff = computeDiff(filePath.canonicalPath, oldContent, content);
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `Wrote ${content.length} characters to ${filePath.canonicalPath}`,
        diff,
        diffs: [diff]
      };
    } else if (call.name === "apply_patch") {
      const filePath = await resolveWritableToolPath(call.arguments.path, projectPath, allowOutsideWorkspace);
      const oldContent = await readFile(filePath.canonicalPath, "utf8");
      const patchText = typeof call.arguments.patch === "string" ? call.arguments.patch : "";
      const newContent = patchText
        ? applyUnifiedPatchToContent(oldContent, patchText)
        : applyOldTextPatch(oldContent, getString(call.arguments.oldText, "oldText"), getString(call.arguments.newText, "newText"));
      await writeFile(filePath.canonicalPath, newContent, "utf8");
      const diff = computeDiff(filePath.canonicalPath, oldContent, newContent);
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `Patched ${filePath.canonicalPath}`,
        diff,
        diffs: [diff]
      };
    } else if (call.name === "list_files") {
      const dir = await resolveReadableToolPath(call.arguments.path ?? ".", projectPath, allowOutsideWorkspace);
      const dirStat = await stat(dir.canonicalPath);
      if (!dirStat.isDirectory()) throw new Error("path must be a directory");
      const files = await walkFiles(dir.canonicalPath, getNumber(call.arguments.maxResults, 200));
      result = { toolCallId: call.id, name: call.name, ok: true, content: files.join("\n").slice(0, 12000) };
    } else if (call.name === "search_text") {
      const dir = await resolveReadableToolPath(call.arguments.path ?? ".", projectPath, allowOutsideWorkspace);
      const query = getString(call.arguments.query, "query");
      const pattern = new RegExp(query, "i");
      const matches = await walkFiles(dir.canonicalPath, getNumber(call.arguments.maxResults, 80), { query: pattern });
      result = { toolCallId: call.id, name: call.name, ok: true, content: matches.join("\n").slice(0, 12000) };
    } else if (call.name === "inspect_tree") {
      const dir = await resolveReadableToolPath(call.arguments.path ?? ".", projectPath, allowOutsideWorkspace);
      const tree = await inspectTree(dir.canonicalPath, Math.min(getNumber(call.arguments.depth, 2), 5));
      result = { toolCallId: call.id, name: call.name, ok: true, content: tree.slice(0, 12000) };
    } else if (call.name === "project_diagnostics") {
      const cwd = call.arguments.cwd ? (await resolveReadableToolPath(call.arguments.cwd, projectPath, allowOutsideWorkspace)).canonicalPath : getWorkspaceRoot(projectPath);
      const kind = typeof call.arguments.kind === "string" ? call.arguments.kind : "typecheck";
      const command = await diagnosticCommand(cwd, kind);
      executorResult = await portableExecutor.run({ command, cwd, projectPath, allowOutsideWorkspace });
      exitCode = executorResult.exitCode;
      result = buildExecutorToolResult(call, executorResult, context);
    } else if (call.name === "generate_image") {
      const generated = await generateImage({
        prompt: getString(call.arguments.prompt, "prompt"),
        providerId: context?.providerId,
        model: typeof call.arguments.model === "string" ? call.arguments.model : undefined,
        size: typeof call.arguments.size === "string" ? call.arguments.size as ImageSize : undefined,
        quality: typeof call.arguments.quality === "string" ? call.arguments.quality as ImageQuality : undefined,
        count: getNumber(call.arguments.count, 1)
      });
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `Generated ${generated.attachments.length} image(s) with ${generated.model}.`,
        attachments: generated.attachments
      };
    } else if (call.name === "record_learning") {
      const record = saveLearningRecord({
        projectPath: getWorkspaceRoot(projectPath),
        conversationId: context?.conversationId,
        title: getString(call.arguments.title, "title"),
        insight: getString(call.arguments.insight, "insight"),
        category: getString(call.arguments.category, "category") as LearningRecordCategory,
        evidence: typeof call.arguments.evidence === "string" ? call.arguments.evidence : undefined,
        importance: getNumber(call.arguments.importance, 2),
        dedupeKey: typeof call.arguments.dedupeKey === "string" ? call.arguments.dedupeKey : undefined,
        source: "agent"
      });
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `Learning recorded: ${record.title}`
      };
    } else if (call.name === "web_fetch") {
      const url = getString(call.arguments.url, "url");
      const response = await fetch(url);
      const text = await response.text();
      result = { toolCallId: call.id, name: call.name, ok: response.ok, exitCode: response.status, content: text.slice(0, 12000) };
    } else if (call.name === "run_shell") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) {
        throw new Error("Computer control shell is disabled by config/agent.toml");
      }
      const command = getString(call.arguments.command, "command");
      executorResult = await portableExecutor.run({ command, cwd: call.arguments.cwd, projectPath, allowOutsideWorkspace, secretRefs: call.arguments.secretRefs });
      exitCode = executorResult.exitCode;
      result = buildExecutorToolResult(call, executorResult, context);
    } else if (call.name === "start_process") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) {
        throw new Error("Computer control shell is disabled by config/agent.toml");
      }
      const command = getString(call.arguments.command, "command");
      const process = await managedProcessManager.start({
        command,
        cwd: call.arguments.cwd,
        projectPath,
        allowOutsideWorkspace,
        label: typeof call.arguments.label === "string" ? call.arguments.label : undefined,
        startupWaitMs: getNumber(call.arguments.startupWaitMs, 700),
        secretRefs: call.arguments.secretRefs
      });
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: process.status === "running" || (process.status === "exited" && process.exitCode === 0),
        exitCode: process.exitCode,
        content: formatProcess(process),
        process
      };
    } else if (call.name === "read_process") {
      const process = managedProcessManager.get(
        getString(call.arguments.processId, "processId"),
        getNumber(call.arguments.tailChars, 20_000)
      );
      if (!process) throw new Error(`Managed process not found: ${String(call.arguments.processId ?? "")}`);
      result = { toolCallId: call.id, name: call.name, ok: true, content: formatProcess(process), process };
    } else if (call.name === "write_process") {
      if (!runtimeConfig.computerControl.enabled || !runtimeConfig.computerControl.shell) {
        throw new Error("Computer control shell is disabled by config/agent.toml");
      }
      const process = managedProcessManager.write(
        getString(call.arguments.processId, "processId"),
        getString(call.arguments.input, "input")
      );
      result = { toolCallId: call.id, name: call.name, ok: true, content: formatProcess(process), process };
    } else if (call.name === "stop_process") {
      const process = await managedProcessManager.stop(getString(call.arguments.processId, "processId"));
      result = { toolCallId: call.id, name: call.name, ok: true, content: formatProcess(process), process };
    } else if (call.name === "list_processes") {
      const processes = managedProcessManager.list(projectPath);
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: processes.length ? processes.map((process) => formatProcess({ ...process, output: process.output.slice(-2_000) })).join("\n\n---\n\n") : "No managed processes for this project."
      };
    } else if (call.name === "docker_compose") {
      const cwd = call.arguments.cwd ? (await resolveReadableToolPath(call.arguments.cwd, projectPath, allowOutsideWorkspace)).canonicalPath : getWorkspaceRoot(projectPath);
      const action = getString(call.arguments.action, "action");
      const allowedActions = new Set(["config", "ps", "logs", "build", "pull", "up", "down", "restart"]);
      if (!allowedActions.has(action)) throw new Error(`Unsupported Docker Compose action: ${action}`);
      const services = getStringArray(call.arguments.services, "services");
      const serviceArgs = services.map(shellQuote).join(" ");
      const tail = Math.max(1, Math.min(getNumber(call.arguments.tail, 200), 2_000));
      const actionArgs = action === "logs" ? `logs --no-color --tail ${tail}` : action === "up" ? "up --detach" : action;
      const command = `docker compose ${actionArgs}${serviceArgs ? ` ${serviceArgs}` : ""}`;
      executorResult = await portableExecutor.run({ command, cwd, projectPath, allowOutsideWorkspace });
      exitCode = executorResult.exitCode;
      result = buildExecutorToolResult(call, executorResult, context);
    } else if (call.name === "sqlite_query") {
      const databasePath = await resolveWritableToolPath(call.arguments.path, projectPath, allowOutsideWorkspace);
      const query = getString(call.arguments.query, "query").trim();
      if (!query) throw new Error("query is required");
      const readOnly = isReadOnlySql(query);
      const database = new DatabaseSync(databasePath.canonicalPath, { readOnly });
      try {
        if (readOnly) {
          const rows = database.prepare(query).all();
          const content = JSON.stringify(rows, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2);
          result = { toolCallId: call.id, name: call.name, ok: true, content: content.slice(0, 12000) };
        } else {
          database.exec(query);
          result = { toolCallId: call.id, name: call.name, ok: true, content: "SQLite statement executed successfully." };
        }
      } finally {
        database.close();
      }
    } else if (call.name === "git_status" || call.name === "git_diff") {
      const cwd = call.arguments.cwd ? (await resolveReadableToolPath(call.arguments.cwd, projectPath, allowOutsideWorkspace)).canonicalPath : getWorkspaceRoot(projectPath);
      const command = call.name === "git_status" ? "git status --short --branch" : `git diff ${call.arguments.staged ? "--staged" : ""}`;
      executorResult = await portableExecutor.run({ command, cwd, projectPath, allowOutsideWorkspace });
      exitCode = executorResult.exitCode;
      result = buildExecutorToolResult(call, executorResult, context);
    } else if (call.name === "git_branch" || call.name === "git_stage" || call.name === "git_commit" || call.name === "git_push") {
      const cwd = call.arguments.cwd ? (await resolveReadableToolPath(call.arguments.cwd, projectPath, allowOutsideWorkspace)).canonicalPath : getWorkspaceRoot(projectPath);
      let command: string;
      if (call.name === "git_branch") {
        const branch = shellQuote(getString(call.arguments.name, "name"));
        command = call.arguments.create === false ? `git switch ${branch}` : `git switch -c ${branch}`;
      } else if (call.name === "git_stage") {
        const paths = Array.isArray(call.arguments.paths) ? call.arguments.paths.map(String) : [];
        if (paths.length === 0) throw new Error("paths is required");
        for (const item of paths) await resolveReadableToolPath(item, projectPath, allowOutsideWorkspace);
        command = `git add -- ${paths.map(shellQuote).join(" ")}`;
      } else if (call.name === "git_commit") {
        command = `git commit -m ${shellQuote(getString(call.arguments.message, "message"))}`;
      } else {
        const remote = shellQuote(typeof call.arguments.remote === "string" ? call.arguments.remote : "origin");
        const branch = typeof call.arguments.branch === "string" ? ` ${shellQuote(call.arguments.branch)}` : "";
        command = `git push${call.arguments.setUpstream ? " --set-upstream" : ""} ${remote}${branch}`;
      }
      executorResult = await portableExecutor.run({ command, cwd, projectPath, allowOutsideWorkspace });
      exitCode = executorResult.exitCode;
      result = buildExecutorToolResult(call, executorResult, context);
    } else {
      throw new Error(`Unknown tool: ${call.name}`);
    }

    outputSummary = result.content.slice(0, 1000);
    auditEventId = recordAuditEvent({
      projectPath,
      conversationId: context?.conversationId,
      toolCallId: call.id,
      toolName: call.name,
      permissionEffect: context?.permissionEffect,
      permissionReason: context?.permissionReason,
      sandboxPolicy: sandboxPolicyName(),
      ok: result.ok,
      exitCode: result.exitCode ?? exitCode,
      durationMs: Date.now() - startedAt,
      input: call.arguments,
      outputSummary,
      executorKind: executorResult?.executorKind,
      cwd: executorResult?.cwd,
      argv: executorResult?.argv,
      networkRisk: executorResult?.riskFlags.includes("network"),
      outsideWorkspaceRisk: executorResult?.riskFlags.some((flag) => flag.includes("outside_workspace")),
      artifactIds: result.artifacts?.map((artifact) => artifact.id)
    });
    return { ...result, auditEventId };
  } catch (error) {
    outputSummary = error instanceof Error ? error.message : "Unknown tool error";
    auditEventId = recordAuditEvent({
      projectPath,
      conversationId: context?.conversationId,
      toolCallId: call.id,
      toolName: call.name,
      permissionEffect: context?.permissionEffect,
      permissionReason: context?.permissionReason,
      sandboxPolicy: sandboxPolicyName(),
      ok: false,
      exitCode,
      durationMs: Date.now() - startedAt,
      input: call.arguments,
      outputSummary
    });
    return {
      toolCallId: call.id,
      name: call.name as AgentToolName,
      ok: false,
      auditEventId,
      content: outputSummary
    };
  }
}

function applyOldTextPatch(oldContent: string, oldText: string, newText: string) {
  if (!oldContent.includes(oldText)) {
    throw new Error("Patch conflict: oldText was not found. Re-read the file before editing.");
  }
  return oldContent.replace(oldText, newText);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function applyUnifiedPatchToContent(oldContent: string, patchText: string) {
  const originalLines = oldContent.split("\n");
  const output: string[] = [];
  let originalIndex = 0;
  const lines = patchText.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (!match) throw new Error(`Invalid unified patch hunk header: ${line}`);
    const oldStart = Number(match[1]) - 1;
    while (originalIndex < oldStart) {
      output.push(originalLines[originalIndex++] ?? "");
    }
    i++;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const hunkLine = lines[i];
      const marker = hunkLine[0];
      const content = hunkLine.slice(1);
      if (marker === " ") {
        if (originalLines[originalIndex] !== content) {
          throw new Error(`Patch conflict near line ${originalIndex + 1}: expected "${content}"`);
        }
        output.push(originalLines[originalIndex++] ?? "");
      } else if (marker === "-") {
        if (originalLines[originalIndex] !== content) {
          throw new Error(`Patch conflict near line ${originalIndex + 1}: expected removal "${content}"`);
        }
        originalIndex++;
      } else if (marker === "+") {
        output.push(content);
      } else if (hunkLine === "\\ No newline at end of file") {
        // Metadata line; ignore for this text-oriented patcher.
      } else if (hunkLine.trim() === "") {
        output.push("");
        originalIndex++;
      } else {
        throw new Error(`Invalid unified patch line: ${hunkLine}`);
      }
      i++;
    }
  }

  while (originalIndex < originalLines.length) {
    output.push(originalLines[originalIndex++] ?? "");
  }
  return output.join("\n");
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
