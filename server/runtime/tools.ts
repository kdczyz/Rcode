import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "./config";
import { recordAuditEvent, saveArtifact } from "../storage/database";
import { portableExecutor } from "./executor";
import { managedProcessManager } from "./processManager";
import { executeMcpTool, listMcpToolDefinitions } from "../integrations/mcpClient";
import { analyzeShellCommand, assertNotSymlinkEscape, assertPathInsideWorkspace, getWorkspaceRoot, sandboxPolicyName } from "../security/sandbox";
import type { AgentToolName, BuiltinToolName, DiffResult, ExecutorResult, ManagedProcessSnapshot, ToolCall, ToolDefinition, ToolResult } from "../shared/types";

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
      cwd: { type: "string", description: "Optional working directory. Defaults to project root." }
    },
    required: ["command"]
  },
  start_process: {
    type: "object",
    properties: {
      command: { type: "string", description: "Long-running command to start. Do not add &, nohup, or output redirection." },
      cwd: { type: "string", description: "Optional working directory. Defaults to project root." },
      label: { type: "string", description: "Short user-facing label, such as Vue dev server." },
      startupWaitMs: { type: "number", description: "Milliseconds to collect startup output before returning (0-3000)." }
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
  }
};

export const registeredTools: ToolDefinition[] = [
  { id: "read_file", name: "read_file", description: "Read a file from the workspace after canonical path checks.", inputSchema: inputSchemas.read_file, source: "builtin", risk: "medium", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "write_file", name: "write_file", description: "Create or overwrite a file with complete content. Prefer apply_patch for edits.", inputSchema: inputSchemas.write_file, source: "builtin", risk: "high", requiresSandbox: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "list_files", name: "list_files", description: "List files under a workspace directory while ignoring build artifacts.", inputSchema: inputSchemas.list_files, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "search_text", name: "search_text", description: "Search text in workspace files while ignoring build artifacts.", inputSchema: inputSchemas.search_text, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "inspect_tree", name: "inspect_tree", description: "Inspect the workspace directory tree.", inputSchema: inputSchemas.inspect_tree, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "apply_patch", name: "apply_patch", description: "Patch an existing file using unified diff or exact oldText/newText replacement.", inputSchema: inputSchemas.apply_patch, source: "builtin", risk: "high", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "web_fetch", name: "web_fetch", description: "Fetch documentation or API references from a URL.", inputSchema: inputSchemas.web_fetch, source: "builtin", risk: "medium", requiresSandbox: false, defaultApproval: "ask", approvalMode: "ask" },
  { id: "run_shell", name: "run_shell", description: "Run a shell command through portable guarded execution.", inputSchema: inputSchemas.run_shell, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "start_process", name: "start_process", description: "Start a guarded long-running process session for dev servers, watchers, and similar commands. Returns immediately with a process ID and startup output.", inputSchema: inputSchemas.start_process, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "read_process", name: "read_process", description: "Read the current state and recent output of a managed process session.", inputSchema: inputSchemas.read_process, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "write_process", name: "write_process", description: "Write input to a running managed process session.", inputSchema: inputSchemas.write_process, source: "builtin", risk: "medium", requiresSandbox: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "stop_process", name: "stop_process", description: "Stop a managed process session and its child process tree.", inputSchema: inputSchemas.stop_process, source: "builtin", risk: "medium", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "list_processes", name: "list_processes", description: "List managed process sessions for the current project.", inputSchema: inputSchemas.list_processes, source: "builtin", risk: "low", requiresSandbox: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "git_status", name: "git_status", description: "Show git status for the workspace.", inputSchema: inputSchemas.git_status, source: "builtin", risk: "low", requiresSandbox: true, requiresExecutor: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "git_diff", name: "git_diff", description: "Show git diff for the workspace.", inputSchema: inputSchemas.git_diff, source: "builtin", risk: "low", requiresSandbox: true, requiresExecutor: true, defaultApproval: "allow", approvalMode: "allow" },
  { id: "git_branch", name: "git_branch", description: "Create or switch a git branch in the workspace.", inputSchema: inputSchemas.git_branch, source: "builtin", risk: "medium", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "git_stage", name: "git_stage", description: "Stage selected workspace paths for commit.", inputSchema: inputSchemas.git_stage, source: "builtin", risk: "medium", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" },
  { id: "git_commit", name: "git_commit", description: "Create a git commit with the staged changes.", inputSchema: inputSchemas.git_commit, source: "builtin", risk: "high", requiresSandbox: true, requiresExecutor: true, defaultApproval: "ask", approvalMode: "ask" }
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

export async function executeTool(call: ToolCall, projectPath?: string, context?: { conversationId?: string; permissionEffect?: string; permissionReason?: string }): Promise<ToolResult> {
  const startedAt = Date.now();
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

    if (call.name.startsWith("mcp__")) {
      const mcpResult = await executeMcpTool(call);
      const summarized = summarizeWithArtifacts(mcpResult.content, context);
      result = {
        toolCallId: call.id,
        name: call.name,
        ok: mcpResult.ok,
        content: summarized.content,
        summary: summarized.summary,
        artifacts: summarized.artifacts
      };
    } else if (call.name === "read_file") {
      const filePath = await assertPathInsideWorkspace(call.arguments.path, projectPath);
      const content = await readFile(filePath.canonicalPath, "utf8");
      result = { toolCallId: call.id, name: call.name, ok: true, content: content.slice(0, 12000) };
    } else if (call.name === "write_file") {
      const filePath = await assertNotSymlinkEscape(call.arguments.path, projectPath);
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
      const filePath = await assertNotSymlinkEscape(call.arguments.path, projectPath);
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
      const dir = await assertPathInsideWorkspace(call.arguments.path ?? ".", projectPath);
      const dirStat = await stat(dir.canonicalPath);
      if (!dirStat.isDirectory()) throw new Error("path must be a directory");
      const files = await walkFiles(dir.canonicalPath, getNumber(call.arguments.maxResults, 200));
      result = { toolCallId: call.id, name: call.name, ok: true, content: files.join("\n").slice(0, 12000) };
    } else if (call.name === "search_text") {
      const dir = await assertPathInsideWorkspace(call.arguments.path ?? ".", projectPath);
      const query = getString(call.arguments.query, "query");
      const pattern = new RegExp(query, "i");
      const matches = await walkFiles(dir.canonicalPath, getNumber(call.arguments.maxResults, 80), { query: pattern });
      result = { toolCallId: call.id, name: call.name, ok: true, content: matches.join("\n").slice(0, 12000) };
    } else if (call.name === "inspect_tree") {
      const dir = await assertPathInsideWorkspace(call.arguments.path ?? ".", projectPath);
      const tree = await inspectTree(dir.canonicalPath, Math.min(getNumber(call.arguments.depth, 2), 5));
      result = { toolCallId: call.id, name: call.name, ok: true, content: tree.slice(0, 12000) };
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
      const analysis = await analyzeShellCommand(command, call.arguments.cwd, projectPath);
      if (analysis.blockedReason) throw new Error(analysis.blockedReason);
      executorResult = await portableExecutor.run({ command, cwd: analysis.cwd, projectPath });
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
        label: typeof call.arguments.label === "string" ? call.arguments.label : undefined,
        startupWaitMs: getNumber(call.arguments.startupWaitMs, 700)
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
    } else if (call.name === "git_status" || call.name === "git_diff") {
      const cwd = call.arguments.cwd ? (await assertPathInsideWorkspace(call.arguments.cwd, projectPath)).canonicalPath : getWorkspaceRoot(projectPath);
      const command = call.name === "git_status" ? "git status --short --branch" : `git diff ${call.arguments.staged ? "--staged" : ""}`;
      executorResult = await portableExecutor.run({ command, cwd, projectPath });
      exitCode = executorResult.exitCode;
      result = buildExecutorToolResult(call, executorResult, context);
    } else if (call.name === "git_branch" || call.name === "git_stage" || call.name === "git_commit") {
      const cwd = call.arguments.cwd ? (await assertPathInsideWorkspace(call.arguments.cwd, projectPath)).canonicalPath : getWorkspaceRoot(projectPath);
      let command: string;
      if (call.name === "git_branch") {
        const branch = shellQuote(getString(call.arguments.name, "name"));
        command = call.arguments.create === false ? `git switch ${branch}` : `git switch -c ${branch}`;
      } else if (call.name === "git_stage") {
        const paths = Array.isArray(call.arguments.paths) ? call.arguments.paths.map(String) : [];
        if (paths.length === 0) throw new Error("paths is required");
        for (const item of paths) await assertPathInsideWorkspace(item, projectPath);
        command = `git add -- ${paths.map(shellQuote).join(" ")}`;
      } else {
        command = `git commit -m ${shellQuote(getString(call.arguments.message, "message"))}`;
      }
      executorResult = await portableExecutor.run({ command, cwd, projectPath });
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
