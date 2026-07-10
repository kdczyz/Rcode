import type { AgentToolName, BuiltinToolName, LegacyPermissionMode, PermissionMode, ToolCall, ToolRisk } from "./types";
import { getRuntimeConfig } from "./config";
import { evaluatePermission } from "./permissionRules";

const toolRisks: Record<BuiltinToolName, ToolRisk> = {
  read_file: "medium",
  write_file: "high",
  list_files: "low",
  search_text: "low",
  inspect_tree: "low",
  apply_patch: "high",
  web_fetch: "medium",
  run_shell: "high",
  git_status: "low",
  git_diff: "low",
  git_branch: "medium",
  git_stage: "medium",
  git_commit: "high"
};

export function getToolRisk(toolName: AgentToolName): ToolRisk {
  if (toolName.startsWith("mcp__")) return "medium";
  return getRuntimeConfig().tools.get(toolName)?.risk ?? toolRisks[toolName as BuiltinToolName] ?? "medium";
}

export function getToolCallRisk(toolCall: ToolCall): ToolRisk {
  return getToolRisk(toolCall.name);
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  if (value === "default" || value === "plan" || value === "workspace_write" || value === "full_access" || value === "custom") {
    return value;
  }
  const legacy = value as LegacyPermissionMode;
  if (legacy === "request_approval" || legacy === "auto_approve") return "workspace_write";
  return getRuntimeConfig().defaultPermissionMode;
}

export async function needsApproval(mode: PermissionMode, toolCall: ToolCall, projectPath?: string): Promise<boolean> {
  const decision = await evaluatePermission(mode, toolCall, projectPath);
  return decision.requiresApproval;
}

export function describePermissionMode(mode: PermissionMode): string {
  if (mode === "default") return "使用配置文件中的默认工作区沙箱策略";
  if (mode === "plan") return "只读规划模式，不允许写文件、联网或执行命令";
  if (mode === "workspace_write") return "工作区内自主执行，越界、联网和危险操作请求审批";
  if (mode === "custom") return "按自定义权限规则执行";
  return "允许所有工具操作直接执行，高风险";
}
