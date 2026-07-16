import { URL } from "node:url";
import { listPermissionRules } from "../storage/database";
import { analyzeShellCommand, resolveWorkspacePath } from "./sandbox";
import type { EnforcementDecision, PermissionEffect, PermissionMode, PermissionRule, ToolCall } from "../shared/types";

export interface PermissionDecision {
  effect: PermissionEffect;
  policyEffect: PermissionEffect;
  enforcement: EnforcementDecision;
  reason: string;
  matchedRule?: PermissionRule;
  requiresApproval: boolean;
}

const managedRules: PermissionRule[] = [
  { id: "managed-deny-sensitive-env", effect: "deny", targetType: "path", pattern: "**/.env*", scope: "managed", enabled: true },
  { id: "managed-deny-ssh", effect: "deny", targetType: "path", pattern: "**/.ssh/**", scope: "managed", enabled: true },
  { id: "managed-ask-web", effect: "ask", targetType: "tool", pattern: "web_fetch", scope: "managed", enabled: true },
  { id: "managed-ask-shell-network", effect: "ask", targetType: "command", pattern: "curl", scope: "managed", enabled: true },
  { id: "managed-ask-git-branch", effect: "ask", targetType: "tool", pattern: "git_branch", scope: "managed", enabled: true },
  { id: "managed-ask-git-stage", effect: "ask", targetType: "tool", pattern: "git_stage", scope: "managed", enabled: true },
  { id: "managed-ask-git-commit", effect: "ask", targetType: "tool", pattern: "git_commit", scope: "managed", enabled: true }
];

const readOnlyComputerTools = new Set([
  "take_screenshot",
  "list_windows",
  "list_apps",
  "get_displays",
  "find_text",
  "element_at_point",
  "take_ax_snapshot",
  "probe_app",
  "cdp_take_dom_snapshot",
  "cdp_summarize_page",
  "cdp_find_elements",
  "cdp_get_element_context",
  "cdp_list_pages",
  "cdp_element_at_point"
]);

function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(pattern: string, value: string) {
  if (pattern === "*" || pattern === value) return true;
  if (pattern.includes("*")) return globToRegExp(pattern).test(value);
  return value.includes(pattern);
}

async function targetValuesForToolCall(toolCall: ToolCall, projectPath?: string) {
  const values: Array<{ targetType: PermissionRule["targetType"]; value: string }> = [
    { targetType: "tool", value: toolCall.name }
  ];

  if (toolCall.name === "read_file" || toolCall.name === "write_file" || toolCall.name === "apply_patch") {
    const resolved = await resolveWorkspacePath(toolCall.arguments.path, projectPath);
    values.push({ targetType: "path", value: resolved.canonicalPath });
    values.push({ targetType: "path", value: resolved.input });
  }

  if (toolCall.name === "list_files" || toolCall.name === "search_text" || toolCall.name === "inspect_tree") {
    const rawPath = toolCall.arguments.path ?? ".";
    const resolved = await resolveWorkspacePath(rawPath, projectPath);
    values.push({ targetType: "path", value: resolved.canonicalPath });
    values.push({ targetType: "path", value: resolved.input });
  }

  if (toolCall.name === "run_shell" || toolCall.name === "start_process") {
    const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
    values.push({ targetType: "command", value: command });
  }

  if (toolCall.name === "web_fetch") {
    const rawUrl = typeof toolCall.arguments.url === "string" ? toolCall.arguments.url : "";
    values.push({ targetType: "url", value: rawUrl });
    try {
      values.push({ targetType: "url", value: new URL(rawUrl).host });
    } catch {
      // Invalid URL falls through to default approval.
    }
  }

  return values;
}

function resolveRule(rules: PermissionRule[], values: Array<{ targetType: PermissionRule["targetType"]; value: string }>) {
  const enabled = rules.filter((rule) => rule.enabled);
  for (const effect of ["deny", "ask", "allow"] as const) {
    const match = enabled.find((rule) =>
      rule.effect === effect &&
      values.some((value) => value.targetType === rule.targetType && matchesPattern(rule.pattern, value.value))
    );
    if (match) return match;
  }
  return undefined;
}

export async function evaluatePermission(
  mode: PermissionMode,
  toolCall: ToolCall,
  projectPath?: string
): Promise<PermissionDecision> {
  const decision = (
    effect: PermissionEffect,
    reason: string,
    overrides: Partial<PermissionDecision> = {}
  ): PermissionDecision => ({
    effect,
    policyEffect: overrides.policyEffect ?? effect,
    enforcement: overrides.enforcement ?? (effect === "allow" ? "guarded" : effect === "ask" ? "requires_approval" : "denied"),
    reason,
    matchedRule: overrides.matchedRule,
    requiresApproval: overrides.requiresApproval ?? effect === "ask"
  });

  if (mode === "full_access") {
    return decision("allow", "Full access mode allows this tool call.", { enforcement: "guarded", requiresApproval: false });
  }

  if (mode === "plan") {
    const effect: PermissionEffect = toolCall.name === "read_file" || toolCall.name === "list_files" || toolCall.name === "search_text" || toolCall.name === "inspect_tree" || toolCall.name === "git_status" || toolCall.name === "git_diff" || toolCall.name === "read_process" || toolCall.name === "list_processes"
      ? "allow"
      : "deny";
    return decision(effect, effect === "allow" ? "Plan mode allows read-only inspection." : "Plan mode blocks writes, shell commands, and network access.", {
      enforcement: effect === "allow" ? "guarded" : "denied",
      requiresApproval: false
    });
  }

  const values = await targetValuesForToolCall(toolCall, projectPath);
  const matchedRule = resolveRule([...managedRules, ...listPermissionRules()], values);
  if (matchedRule) {
    return decision(matchedRule.effect, `${matchedRule.scope} rule ${matchedRule.id} matched ${matchedRule.targetType}:${matchedRule.pattern}`, {
      matchedRule,
      enforcement: matchedRule.effect === "allow" ? "guarded" : matchedRule.effect === "ask" ? "requires_approval" : "denied",
      requiresApproval: matchedRule.effect === "ask"
    });
  }

  if (toolCall.name === "web_fetch") {
    return decision("ask", "Network access requires approval by default.");
  }

  if (toolCall.name.startsWith("mcp__")) {
    if (toolCall.name.startsWith("mcp__native-devtools__")) {
      const toolName = toolCall.name.slice("mcp__native-devtools__".length);
      if (readOnlyComputerTools.has(toolName)) {
        return decision("allow", "Read-only computer inspection is allowed; UI mutations still require approval.", {
          enforcement: "guarded",
          requiresApproval: false
        });
      }
    }
    return decision("ask", "MCP tool calls require approval until the server and tool are explicitly trusted.");
  }

  if (toolCall.name === "run_shell" || toolCall.name === "start_process") {
    const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
    const analysis = await analyzeShellCommand(command, toolCall.arguments.cwd, projectPath);
    if (analysis.blockedReason || analysis.destructive || analysis.redirectsOutsideWorkspace || analysis.leaksEnvironment || analysis.backgroundProcess || analysis.interactive) {
      return decision("deny", analysis.blockedReason ?? `Shell command blocked by portable guard: ${analysis.riskFlags.join(", ")}`, {
        enforcement: "denied",
        requiresApproval: false
      });
    }
    if (analysis.mentionsOutsideWorkspace || analysis.mayUseNetwork) {
      return decision("ask", "Shell command crosses the workspace or network boundary.");
    }
    return decision("allow", "Routine shell command stays within the workspace boundary.", {
      enforcement: "guarded",
      requiresApproval: false
    });
  }

  for (const value of values.filter((item) => item.targetType === "path")) {
    const resolved = await resolveWorkspacePath(value.value, projectPath);
    if (!resolved.insideWorkspace) {
      return decision("ask", "File operation crosses the workspace boundary.");
    }
  }

  return decision("allow", "Workspace-write default policy allows this tool call.", { requiresApproval: false });
}

export function defaultPermissionRules() {
  return managedRules;
}
