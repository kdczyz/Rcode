import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { analyzeShellCommand, getWorkspaceRoot } from "../security/sandbox";
import { redactSecrets, resolveSecretEnvironment } from "../security/secrets";
import type { ManagedProcessSnapshot, ManagedProcessStatus } from "../shared/types";

const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_TAIL_CHARS = 20_000;
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

interface ManagedProcessRecord {
  child: ChildProcessWithoutNullStreams;
  id: string;
  command: string;
  label?: string;
  cwd: string;
  projectPath: string;
  pid?: number;
  status: ManagedProcessStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
  output: string;
  outputVersion: number;
  stopRequested: boolean;
  secretValues: string[];
  redactionCarry: string;
}

export interface StartManagedProcessInput {
  command: string;
  cwd?: unknown;
  projectPath?: string;
  allowOutsideWorkspace?: boolean;
  label?: string;
  startupWaitMs?: number;
  secretRefs?: unknown;
}

function safeEnvironment() {
  const allowedPrefixes = ["PATH", "HOME", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_", "TERM", "COLORTERM"];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (allowedPrefixes.some((prefix) => key === prefix || key.startsWith(prefix))) env[key] = value;
  }
  env.FORCE_COLOR = "0";
  return env;
}

function stripAnsi(value: string) {
  return value.replace(ANSI_PATTERN, "");
}

function appendOutput(record: ManagedProcessRecord, chunk: Buffer | string) {
  const raw = stripAnsi(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  if (record.secretValues.length === 0) {
    record.output = `${record.output}${raw}`.slice(-MAX_OUTPUT_CHARS);
    record.outputVersion += 1;
    return;
  }
  const combined = `${record.redactionCarry}${raw}`;
  const maxSecretLength = Math.max(...record.secretValues.map((secret) => secret.length));
  let safeCutoff = Math.max(0, combined.length - (maxSecretLength - 1));
  let extended = true;
  while (extended) {
    extended = false;
    for (const secret of record.secretValues) {
      let index = combined.indexOf(secret);
      while (index >= 0) {
        const end = index + secret.length;
        if (index < safeCutoff && end > safeCutoff) {
          safeCutoff = end;
          extended = true;
        }
        index = combined.indexOf(secret, index + 1);
      }
    }
  }
  const next = redactSecrets(combined.slice(0, safeCutoff), record.secretValues);
  record.redactionCarry = combined.slice(safeCutoff);
  record.output = `${record.output}${next}`.slice(-MAX_OUTPUT_CHARS);
  record.outputVersion += 1;
}

function flushRedactionCarry(record: ManagedProcessRecord) {
  if (!record.redactionCarry) return;
  record.output = `${record.output}${redactSecrets(record.redactionCarry, record.secretValues)}`.slice(-MAX_OUTPUT_CHARS);
  record.redactionCarry = "";
  record.outputVersion += 1;
}

function snapshot(record: ManagedProcessRecord, tailChars = DEFAULT_TAIL_CHARS): ManagedProcessSnapshot {
  return {
    id: record.id,
    command: record.command,
    label: record.label,
    cwd: record.cwd,
    projectPath: record.projectPath,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    output: record.output.slice(-Math.max(0, Math.min(tailChars, MAX_OUTPUT_CHARS))),
    outputVersion: record.outputVersion
  };
}

function killProcessTree(record: ManagedProcessRecord, signal: NodeJS.Signals) {
  if (!record.pid) return;
  try {
    if (process.platform === "win32") record.child.kill(signal);
    else process.kill(-record.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ManagedProcessManager {
  private readonly records = new Map<string, ManagedProcessRecord>();

  constructor() {
    process.once("exit", () => {
      for (const record of this.records.values()) {
        if (record.status === "running") {
          try { killProcessTree(record, "SIGTERM"); } catch { /* process is already exiting */ }
        }
      }
    });
  }

  async start(input: StartManagedProcessInput) {
    const projectPath = getWorkspaceRoot(input.projectPath);
    const analysis = await analyzeShellCommand(input.command, input.cwd, projectPath);
    const boundaryReason = input.allowOutsideWorkspace
      ? undefined
      : (!analysis.cwdInsideWorkspace ? "Command cwd is outside the workspace." : undefined) ??
        (analysis.redirectsOutsideWorkspace ? "Command redirects output outside the workspace." : undefined);
    const blockedReason = (analysis.blockedReason === "Command cwd is outside the workspace." && input.allowOutsideWorkspace
      ? undefined
      : analysis.blockedReason) ??
      boundaryReason ??
      (analysis.backgroundProcess ? "Do not use &, nohup, or disown; start_process manages the process lifecycle." : undefined) ??
      (analysis.interactive ? "Interactive terminal applications are not supported by managed process sessions." : undefined) ??
      (analysis.leaksEnvironment ? "Command may expose sensitive environment variables." : undefined);
    if (blockedReason) throw new Error(blockedReason);
    const secrets = resolveSecretEnvironment(input.secretRefs);

    const id = `process_${randomUUID()}`;
    const child = spawn("zsh", ["-lc", input.command], {
      cwd: analysis.cwd,
      env: { ...safeEnvironment(), ...secrets.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const record: ManagedProcessRecord = {
      child,
      id,
      command: input.command,
      label: input.label?.trim() || undefined,
      cwd: analysis.cwd,
      projectPath,
      pid: child.pid,
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
      outputVersion: 0,
      stopRequested: false,
      secretValues: secrets.values,
      redactionCarry: ""
    };
    this.records.set(id, record);

    child.stdout.on("data", (chunk) => appendOutput(record, chunk));
    child.stderr.on("data", (chunk) => appendOutput(record, chunk));
    child.on("error", (error) => {
      appendOutput(record, `${error.message}\n`);
      flushRedactionCarry(record);
      record.status = "failed";
      record.endedAt = new Date().toISOString();
    });
    child.on("exit", (code, signal) => {
      flushRedactionCarry(record);
      record.exitCode = code ?? undefined;
      record.signal = signal ?? undefined;
      record.endedAt = new Date().toISOString();
      record.status = record.stopRequested ? "stopped" : code === null || code !== 0 ? "failed" : "exited";
    });

    const startupWaitMs = Math.max(0, Math.min(input.startupWaitMs ?? 700, 3_000));
    if (startupWaitMs > 0) await wait(startupWaitMs);
    return snapshot(record);
  }

  get(id: string, tailChars?: number) {
    const record = this.records.get(id);
    return record ? snapshot(record, tailChars) : undefined;
  }

  list(projectPath?: string) {
    return [...this.records.values()]
      .filter((record) => !projectPath || record.projectPath === projectPath)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => snapshot(record));
  }

  write(id: string, input: string) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Managed process not found: ${id}`);
    if (record.status !== "running") throw new Error(`Managed process is not running: ${id}`);
    record.child.stdin.write(input);
    return snapshot(record);
  }

  async stop(id: string) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Managed process not found: ${id}`);
    if (record.status !== "running") return snapshot(record);

    record.stopRequested = true;
    killProcessTree(record, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (record.status === "running" && Date.now() < deadline) await wait(50);
    if (record.status === "running") {
      killProcessTree(record, "SIGKILL");
      while (record.status === "running" && Date.now() < deadline + 1_000) await wait(25);
    }
    return snapshot(record);
  }
}

export const managedProcessManager = new ManagedProcessManager();
