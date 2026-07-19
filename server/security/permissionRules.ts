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
  { id: "managed-deny-keychains", effect: "deny", targetType: "path", pattern: "**/Library/Keychains/**", scope: "managed", enabled: true },
  { id: "managed-deny-browser-passwords", effect: "deny", targetType: "path", pattern: "**/Library/Application Support/**/Login Data", scope: "managed", enabled: true },
  { id: "managed-ask-web", effect: "ask", targetType: "tool", pattern: "web_fetch", scope: "managed", enabled: true },
  { id: "managed-allow-requested-image-generation", effect: "allow", targetType: "tool", pattern: "generate_image", scope: "managed", enabled: true },
  { id: "managed-ask-shell-network", effect: "ask", targetType: "command", pattern: "curl", scope: "managed", enabled: true },
  { id: "managed-ask-git-branch", effect: "ask", targetType: "tool", pattern: "git_branch", scope: "managed", enabled: true },
  { id: "managed-ask-git-stage", effect: "ask", targetType: "tool", pattern: "git_stage", scope: "managed", enabled: true },
  { id: "managed-ask-git-commit", effect: "ask", targetType: "tool", pattern: "git_commit", scope: "managed", enabled: true },
  { id: "managed-ask-git-push", effect: "ask", targetType: "tool", pattern: "git_push", scope: "managed", enabled: true }
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

  if (toolCall.name === "list_files" || toolCall.name === "search_text" || toolCall.name === "inspect_tree" || toolCall.name === "sqlite_query") {
    const rawPath = toolCall.arguments.path ?? ".";
    const resolved = await resolveWorkspacePath(rawPath, projectPath);
    values.push({ targetType: "path", value: resolved.canonicalPath });
    values.push({ targetType: "path", value: resolved.input });
  }

  if (toolCall.name === "run_shell" || toolCall.name === "start_process") {
    const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
    values.push({ targetType: "command", value: command });
  }

  if (toolCall.name === "project_diagnostics" || toolCall.name === "docker_compose" || toolCall.name.startsWith("git_")) {
    const rawPath = toolCall.arguments.cwd ?? ".";
    const resolved = await resolveWorkspacePath(rawPath, projectPath);
    values.push({ targetType: "path", value: resolved.canonicalPath });
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

  const values = await targetValuesForToolCall(toolCall, projectPath);
  const matchedManagedDeny = resolveRule(managedRules.filter((rule) => rule.effect === "deny"), values);
  if (matchedManagedDeny) {
    return decision("deny", `${matchedManagedDeny.scope} rule ${matchedManagedDeny.id} matched ${matchedManagedDeny.targetType}:${matchedManagedDeny.pattern}`, {
      matchedRule: matchedManagedDeny,
      enforcement: "denied",
      requiresApproval: false
    });
  }

  if (mode !== "full_access") {
    for (const value of values.filter((item) => item.targetType === "path")) {
      const resolved = await resolveWorkspacePath(value.value, projectPath);
      if (!resolved.insideWorkspace) {
        return decision("deny", "Personal files outside the workspace are denied by default.", { enforcement: "denied", requiresApproval: false });
      }
    }
  }

  if (mode === "plan") {
    const effect: PermissionEffect = toolCall.name === "read_file" || toolCall.name === "list_files" || toolCall.name === "search_text" || toolCall.name === "inspect_tree" || toolCall.name === "project_diagnostics" || toolCall.name === "git_status" || toolCall.name === "git_diff" || toolCall.name === "read_process" || toolCall.name === "list_processes"
      ? "allow"
      : "deny";
    return decision(effect, effect === "allow" ? "Plan mode allows read-only inspection." : "Plan mode blocks writes, shell commands, and network access.", {
      enforcement: effect === "allow" ? "guarded" : "denied",
      requiresApproval: false
    });
  }

  const matchedManagedRule = resolveRule(managedRules, values);
  if (matchedManagedRule) {
    return decision(matchedManagedRule.effect, `${matchedManagedRule.scope} rule ${matchedManagedRule.id} matched ${matchedManagedRule.targetType}:${matchedManagedRule.pattern}`, {
      matchedRule: matchedManagedRule,
      enforcement: matchedManagedRule.effect === "allow" ? "guarded" : matchedManagedRule.effect === "ask" ? "requires_approval" : "denied",
      requiresApproval: matchedManagedRule.effect === "ask"
    });
  }

  const matchedRule = resolveRule(listPermissionRules(), values);

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
    const hardBlockedReason = analysis.blockedReason === "Command cwd is outside the workspace."
      ? undefined
      : analysis.blockedReason;
    const workspaceBoundaryBlocked = mode !== "full_access" && (
      !analysis.cwdInsideWorkspace || analysis.redirectsOutsideWorkspace || analysis.mentionsOutsideWorkspace
    );
    if (hardBlockedReason || workspaceBoundaryBlocked || analysis.leaksEnvironment || analysis.backgroundProcess || analysis.interactive || analysis.credentialAccess) {
      return decision("deny", hardBlockedReason ?? (workspaceBoundaryBlocked
        ? "Shell commands may not access personal files outside the workspace."
        : `Shell command blocked by portable guard: ${analysis.riskFlags.join(", ")}`), {
        enforcement: "denied",
        requiresApproval: false
      });
    }
    const secretRefs = Array.isArray(toolCall.arguments.secretRefs) ? toolCall.arguments.secretRefs : [];
    if (secretRefs.length > 0) {
      return decision("ask", `Secret injection requires approval for: ${secretRefs.map(String).join(", ")}.`);
    }
    if (analysis.destructive || analysis.productionOperation || analysis.privilegeElevation) {
      return decision("ask", "Destructive, privileged, or production operations require one-time approval.");
    }
    if (analysis.mayUseNetwork || analysis.installsDependencies || analysis.databaseMigration || analysis.databaseMutation || analysis.dockerMutation || analysis.gitMutation || analysis.deployment) {
      return decision("ask", "Dependency, network, database, container, Git mutation, or deployment operations require approval.");
    }
    return decision("allow", "Routine shell command stays within the workspace boundary.", {
      enforcement: "guarded",
      requiresApproval: false
    });
  }

  if (toolCall.name === "docker_compose") {
    const action = String(toolCall.arguments.action ?? "ps");
    return action === "ps" || action === "config" || action === "logs"
      ? decision("allow", "Read-only Docker Compose inspection is allowed.", { requiresApproval: false })
      : decision("ask", "Docker Compose mutations require approval.");
  }

  if (toolCall.name === "sqlite_query") {
    const query = String(toolCall.arguments.query ?? "").trim();
    return /^(select|pragma\b(?![\s\S]*=)|explain|with\b[\s\S]*\bselect\b)/i.test(query)
      ? decision("allow", "Read-only SQLite queries are allowed inside the workspace.", { requiresApproval: false })
      : decision("ask", "SQLite mutations require one-time approval.");
  }

  if (matchedRule) {
    return decision(matchedRule.effect, `${matchedRule.scope} rule ${matchedRule.id} matched ${matchedRule.targetType}:${matchedRule.pattern}`, {
      matchedRule,
      enforcement: matchedRule.effect === "allow" ? "guarded" : matchedRule.effect === "ask" ? "requires_approval" : "denied",
      requiresApproval: matchedRule.effect === "ask"
    });
  }

  if (mode === "full_access") {
    return decision("allow", "Full access mode allows this tool call after mandatory safety rules.", { enforcement: "guarded", requiresApproval: false });
  }

  return decision("allow", "Workspace-write default policy allows this tool call.", { requiresApproval: false });
}

export function defaultPermissionRules() {
  return managedRules;
}
