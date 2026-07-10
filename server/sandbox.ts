import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "./config";
import type { ShellAnalysis } from "./types";

export interface ResolvedPath {
  input: string;
  workspaceRoot: string;
  absolutePath: string;
  canonicalPath: string;
  insideWorkspace: boolean;
}

export function getWorkspaceRoot(projectPath?: string) {
  return projectPath && path.isAbsolute(projectPath) ? path.resolve(projectPath) : process.cwd();
}

export async function resolveWorkspacePath(input: unknown, projectPath?: string): Promise<ResolvedPath> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("path is required");
  }

  const workspaceRoot = await realpath(getWorkspaceRoot(projectPath));
  const absolutePath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(workspaceRoot, input);

  let canonicalPath = absolutePath;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    canonicalPath = await resolveMissingPath(absolutePath);
  }

  const relativePath = path.relative(workspaceRoot, canonicalPath);
  const insideWorkspace = relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  return { input, workspaceRoot, absolutePath, canonicalPath, insideWorkspace };
}

async function resolveMissingPath(absolutePath: string): Promise<string> {
  const missingSegments: string[] = [];
  let current = absolutePath;

  while (true) {
    try {
      const canonicalExistingPath = await realpath(current);
      return path.join(canonicalExistingPath, ...missingSegments.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

export async function assertPathInsideWorkspace(input: unknown, projectPath?: string) {
  const resolved = await resolveWorkspacePath(input, projectPath);
  if (!resolved.insideWorkspace) {
    throw new Error(`Path is outside the workspace: ${resolved.input}`);
  }
  return resolved;
}

export async function assertNotSymlinkEscape(input: unknown, projectPath?: string) {
  const resolved = await assertPathInsideWorkspace(input, projectPath);
  try {
    const stat = await lstat(resolved.absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await resolveWorkspacePath(resolved.absolutePath, projectPath);
      if (!target.insideWorkspace) {
      throw new Error(`Symlink escapes the workspace: ${resolved.input}`);
      }
    }
  } catch {
    // Missing files are allowed for create/write after parent canonicalization.
  }
  return resolved;
}

function splitCommandSegments(command: string) {
  return command
    .split(/[\n;&|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasInteractivePattern(command: string) {
  return /\b(vim|vi|nano|less|more|top|htop|ssh|mysql|psql|python|node|tsx|bash|zsh)\s*$/.test(command.trim()) ||
    /\bread\s+(-r\s+)?\w+/.test(command);
}

function hasBackgroundProcess(command: string) {
  return /(^|[^&])&\s*(?:$|[#\n])/.test(command) || /\b(nohup|disown)\b/.test(command);
}

function hasEnvLeakPattern(command: string) {
  return /\b(env|printenv|export\s+-p|set)\b/.test(command) ||
    /\$([A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z_]*)\b/.test(command);
}

function isRoutineWorkspaceCommand(command: string) {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) =>
    /^(npm|pnpm|yarn|bun)\s+(test|run\s+[\w:-]+|exec\s+[\w:-]+)(\s|$)/.test(segment) ||
    /^npx\s+[\w@./:-]+(\s|$)/.test(segment) ||
    /^git\s+(status|diff|log|show|branch)(\s|$)/.test(segment) ||
    /^(node|tsx)\s+[\w./:-]+(\s|$)/.test(segment) ||
    /^python3?\s+[\w./:-]+(\s|$)/.test(segment)
  );
}

export async function analyzeShellCommand(command: string, cwdInput: unknown, projectPath?: string): Promise<ShellAnalysis> {
  const workspaceRoot = await realpath(getWorkspaceRoot(projectPath));
  const cwdResolved = cwdInput ? await resolveWorkspacePath(cwdInput, projectPath) : await resolveWorkspacePath(".", workspaceRoot);
  const cwd = cwdResolved.canonicalPath;
  const runtimeConfig = getRuntimeConfig();
  const blocked = runtimeConfig.computerControl.blockedCommands.find((item) => command.includes(item));
  const dangerousPatterns = [
    /\brm\s+-[^\n;|&]*r[^\n;|&]*f\b/,
    /\bsudo\b/,
    /\bchmod\s+-R\b/,
    /\bchown\s+-R\b/,
    /\bdiskutil\b/,
    /\bmkfs\b/,
    /\bshutdown\b/,
    /\breboot\b/
  ];
  const networkPatterns = [
    /\bcurl\b/,
    /\bwget\b/,
    /\bfetch\b/,
    /\bhttpie\b/,
    /\bnpm\s+(install|add|publish)\b/,
    /\bpnpm\s+(install|add|publish)\b/,
    /\byarn\s+(add|install|publish)\b/,
    /\bgit\s+(clone|fetch|pull|push)\b/,
    /\bssh\b/,
    /\bscp\b/,
    /\brsync\b.*:/
  ];
  const absolutePathMatches = [...command.matchAll(/(?:^|\s)(\/[^\s'"`;&|()]+)/g)];
  let mentionsOutsideWorkspace = false;
  for (const match of absolutePathMatches) {
    const resolved = await resolveWorkspacePath(match[1], projectPath);
    if (!resolved.insideWorkspace) mentionsOutsideWorkspace = true;
  }
  const redirectMatches = [...command.matchAll(/(?:^|\s)(?:>>?|2>|&>)\s*([^\s'"`;&|()]+)/g)];
  let redirectsOutsideWorkspace = false;
  for (const match of redirectMatches) {
    const target = match[1];
    if (!target || target.startsWith("-")) continue;
    const resolved = await resolveWorkspacePath(target, projectPath);
    if (!resolved.insideWorkspace) redirectsOutsideWorkspace = true;
  }

  const mayUseNetwork = networkPatterns.some((pattern) => pattern.test(command));
  const destructive = dangerousPatterns.some((pattern) => pattern.test(command)) ||
    /\b(rm|mv|cp)\b[\s\S]*(?:\.\.|\/)/.test(command) && mentionsOutsideWorkspace;
  const leaksEnvironment = hasEnvLeakPattern(command);
  const backgroundProcess = hasBackgroundProcess(command);
  const interactive = hasInteractivePattern(command);
  const riskFlags = [
    !cwdResolved.insideWorkspace ? "cwd_outside_workspace" : "",
    mentionsOutsideWorkspace ? "mentions_outside_workspace" : "",
    redirectsOutsideWorkspace ? "redirects_outside_workspace" : "",
    mayUseNetwork ? "network" : "",
    destructive ? "destructive" : "",
    leaksEnvironment ? "env_leak" : "",
    backgroundProcess ? "background_process" : "",
    interactive ? "interactive" : "",
    isRoutineWorkspaceCommand(command) ? "routine_workspace_command" : ""
  ].filter(Boolean);

  return {
    command,
    cwd,
    cwdInsideWorkspace: cwdResolved.insideWorkspace,
    mentionsOutsideWorkspace,
    redirectsOutsideWorkspace,
    mayUseNetwork,
    destructive,
    leaksEnvironment,
    backgroundProcess,
    interactive,
    riskFlags,
    blockedReason: blocked
      ? `Command is blocked by policy: ${blocked}`
      : !cwdResolved.insideWorkspace
        ? "Command cwd is outside the workspace."
        : undefined
  };
}

export function sandboxPolicyName() {
  return "portable-guarded-execution";
}
