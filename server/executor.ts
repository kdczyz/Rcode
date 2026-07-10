import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeShellCommand } from "./sandbox";
import type { ExecutorResult, ShellAnalysis } from "./types";

const execFileAsync = promisify(execFile);

export interface ExecutorRunInput {
  command: string;
  cwd?: unknown;
  projectPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

function safeEnvironment() {
  const allowedPrefixes = ["PATH", "HOME", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_"];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (allowedPrefixes.some((prefix) => key === prefix || key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

function blockedByPortableGuard(analysis: ShellAnalysis) {
  if (analysis.blockedReason) return analysis.blockedReason;
  if (!analysis.cwdInsideWorkspace) return "Command cwd is outside the workspace.";
  if (analysis.redirectsOutsideWorkspace) return "Command redirects output outside the workspace.";
  if (analysis.backgroundProcess) return "Background shell commands are not allowed.";
  if (analysis.interactive) return "Interactive shell commands are not allowed.";
  if (analysis.leaksEnvironment) return "Command may expose sensitive environment variables.";
  return undefined;
}

export class PortableExecutor {
  readonly kind = "portable" as const;

  async analyze(input: ExecutorRunInput) {
    return analyzeShellCommand(input.command, input.cwd, input.projectPath);
  }

  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const analysis = await this.analyze(input);
    const argv = ["zsh", "-lc", input.command];
    const blockedReason = blockedByPortableGuard(analysis);
    if (blockedReason) {
      return {
        ok: false,
        stdout: "",
        stderr: blockedReason,
        durationMs: Date.now() - startedAt,
        blockedReason,
        riskFlags: analysis.riskFlags,
        cwd: analysis.cwd,
        argv,
        executorKind: this.kind
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync("zsh", ["-lc", input.command], {
        cwd: analysis.cwd,
        timeout: input.timeoutMs ?? 30000,
        maxBuffer: input.maxBuffer ?? 1024 * 1024,
        env: safeEnvironment()
      });
      return {
        ok: true,
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        riskFlags: analysis.riskFlags,
        cwd: analysis.cwd,
        argv,
        executorKind: this.kind
      };
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      const exitCode = typeof err.code === "number" ? err.code : undefined;
      return {
        ok: false,
        exitCode,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        durationMs: Date.now() - startedAt,
        riskFlags: analysis.riskFlags,
        cwd: analysis.cwd,
        argv,
        executorKind: this.kind
      };
    }
  }
}

export const portableExecutor = new PortableExecutor();
