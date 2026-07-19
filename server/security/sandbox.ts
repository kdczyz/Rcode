import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../runtime/config";
import type { ShellAnalysis } from "../shared/types";

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
  return /(?:^|[;&|\n]\s*)(?:env|printenv|export\s+-p|set)(?:\s|$)/.test(command) ||
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
    /\b(npx|bunx|pnpm\s+dlx|yarn\s+dlx)\b/,
    /\bgit\s+(clone|fetch|pull|push)\b/,
    /\bssh\b/,
    /\bscp\b/,
    /\brsync\b.*:/,
    /\b(docker|podman)\s+(pull|push|build)\b/,
    /\b(wrangler\s+deploy|terraform\s+(plan|apply|destroy)|pulumi\s+(preview|up|destroy))\b/,
    /\b(kubectl|helm|aws|gcloud|az)\b/
  ];
  const absolutePathMatches = [...command.matchAll(/(?:^|\s)(\/[^\s'"`;&|()]+)/g)];
  let mentionsOutsideWorkspace = false;
  for (const match of absolutePathMatches) {
    const resolved = await resolveWorkspacePath(match[1], projectPath);
    if (!resolved.insideWorkspace) mentionsOutsideWorkspace = true;
  }
  if (/(^|[\s'"`])~(?:\/|\b)/.test(command)) mentionsOutsideWorkspace = true;
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
  const installsDependencies = /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|upgrade)\b|\b(npx|bunx|pnpm\s+dlx|yarn\s+dlx)\b|\b(pip|pip3)\s+install\b|\b(bundle|cargo)\s+(install|update)\b|\b(go\s+get|brew\s+(install|upgrade))\b/.test(command);
  const databaseMigration = /\b(migrate|migration|db:(?:push|migrate|deploy|reset)|prisma\s+(?:migrate|db\s+push)|drizzle-kit\s+(?:push|migrate)|alembic\s+upgrade|knex\s+migrate|sequelize(?:-cli)?\s+db:migrate)\b/i.test(command);
  const databaseMutation = /\b(psql|mysql|sqlite3|mongosh?)\b[\s\S]*\b(insert|update|delete|drop|truncate|alter|create)\b/i.test(command);
  const dockerMutation = /\b(docker|podman)(?:\s+compose)?\s+(?:up|down|restart|rm|kill|stop|pull|push|build|run|exec|system\s+prune|volume\s+(?:rm|prune))\b/.test(command);
  const gitMutation = /\bgit\s+(?:add|commit|push|merge|rebase|reset|clean|switch|checkout|branch\s+-[dD])\b/.test(command);
  const deployment = /\b(?:wrangler\s+deploy|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy)|vercel(?:\s+deploy)?|netlify\s+deploy|flyctl\s+deploy|firebase\s+deploy|kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|xcodebuild\s+(?:archive|-exportArchive))\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]*(?:deploy|release|publish)(?:\s|$)/.test(command);
  const productionOperation = /(?:^|[\s_-])(?:prod|production)(?:$|[\s_=:-])|--environment[=\s]+prod(?:uction)?\b|--remote\b/.test(command);
  const privilegeElevation = /\b(?:sudo|su\s|doas)\b/.test(command);
  const credentialAccess = /\bsecurity\s+find-(?:generic|internet)-password\b|\b(?:cat|less|more|head|tail|cp|scp)\b[^\n]*?(?:\.ssh\/|id_(?:rsa|ed25519|ecdsa)|Login Data|Cookies|Keychain)|(?:\/|~\/)(?:Library\/Keychains|\.ssh)(?:\/|\b)/i.test(command);
  const leaksEnvironment = hasEnvLeakPattern(command);
  const backgroundProcess = hasBackgroundProcess(command);
  const interactive = hasInteractivePattern(command);
  const riskFlags = [
    !cwdResolved.insideWorkspace ? "cwd_outside_workspace" : "",
    mentionsOutsideWorkspace ? "mentions_outside_workspace" : "",
    redirectsOutsideWorkspace ? "redirects_outside_workspace" : "",
    mayUseNetwork ? "network" : "",
    destructive ? "destructive" : "",
    installsDependencies ? "dependency_install" : "",
    databaseMigration ? "database_migration" : "",
    databaseMutation ? "database_mutation" : "",
    dockerMutation ? "docker_mutation" : "",
    gitMutation ? "git_mutation" : "",
    deployment ? "deployment" : "",
    productionOperation ? "production" : "",
    privilegeElevation ? "privilege_elevation" : "",
    credentialAccess ? "credential_access" : "",
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
    installsDependencies,
    databaseMigration,
    databaseMutation,
    dockerMutation,
    gitMutation,
    deployment,
    productionOperation,
    privilegeElevation,
    credentialAccess,
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
