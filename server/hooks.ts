import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { portableExecutor } from "./executor";
import { recordAuditEvent } from "./localDatabase";
import { getWorkspaceRoot } from "./sandbox";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "Stop";

interface HookCommand {
  command: string;
  enabled?: boolean;
}

interface HooksConfig {
  trustedHash?: string;
  hooks?: Partial<Record<HookEventName, HookCommand[]>>;
}

export interface HookRunResult {
  ok: boolean;
  blocked: boolean;
  messages: string[];
}

function readJsonIfExists(filePath: string): HooksConfig | undefined {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, "utf8")) as HooksConfig;
}

function hashHookConfig(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  const withoutTrust = raw.replace(/"trustedHash"\s*:\s*"[^"]*"\s*,?/g, "");
  return createHash("sha256").update(withoutTrust).digest("hex");
}

function loadHookConfigs(projectPath?: string) {
  const configs: Array<{ scope: "project" | "user"; config: HooksConfig; trusted: boolean; path: string }> = [];
  const userPath = path.join(os.homedir(), ".agent", "hooks.json");
  const userConfig = readJsonIfExists(userPath);
  if (userConfig) configs.push({ scope: "user", config: userConfig, trusted: true, path: userPath });

  const projectHookPath = path.join(getWorkspaceRoot(projectPath), ".agent", "hooks.json");
  const projectConfig = readJsonIfExists(projectHookPath);
  if (projectConfig) {
    const hash = hashHookConfig(projectHookPath);
    configs.push({ scope: "project", config: projectConfig, trusted: projectConfig.trustedHash === hash, path: projectHookPath });
  }
  return configs;
}

export function getProjectHookTrust(projectPath?: string) {
  const projectHookPath = path.join(getWorkspaceRoot(projectPath), ".agent", "hooks.json");
  if (!existsSync(projectHookPath)) return { exists: false, trusted: false, hash: "" };
  const config = readJsonIfExists(projectHookPath);
  const hash = hashHookConfig(projectHookPath);
  return { exists: true, trusted: config?.trustedHash === hash, hash };
}

export async function runHooks(
  eventName: HookEventName,
  input: { projectPath?: string; conversationId?: string; toolName?: string; payload?: unknown }
): Promise<HookRunResult> {
  const messages: string[] = [];
  for (const item of loadHookConfigs(input.projectPath)) {
    if (!item.trusted) {
      messages.push(`${item.scope} hooks are not trusted: ${item.path}`);
      continue;
    }
    const hooks = item.config.hooks?.[eventName]?.filter((hook) => hook.enabled !== false) ?? [];
    for (const hook of hooks) {
      const result = await portableExecutor.run({
        command: hook.command,
        cwd: getWorkspaceRoot(input.projectPath),
        projectPath: input.projectPath,
        timeoutMs: 15000
      });
      recordAuditEvent({
        projectPath: input.projectPath,
        conversationId: input.conversationId,
        toolName: input.toolName,
        permissionEffect: result.ok ? "allow" : "deny",
        permissionReason: `${eventName} hook ${hook.command}`,
        sandboxPolicy: "portable-guarded-execution",
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        input: { eventName, hook: hook.command, payload: input.payload },
        outputSummary: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 1000),
        executorKind: result.executorKind,
        cwd: result.cwd,
        argv: result.argv,
        networkRisk: result.riskFlags.includes("network"),
        outsideWorkspaceRisk: result.riskFlags.some((flag) => flag.includes("outside_workspace"))
      });
      if (!result.ok) {
        messages.push(result.stderr || `Hook failed: ${hook.command}`);
        return { ok: false, blocked: eventName === "PreToolUse" || eventName === "PermissionRequest", messages };
      }
    }
  }
  return { ok: true, blocked: false, messages };
}
