import path from "node:path";
import type { AgentToolName, PermissionMode, ToolCall, ToolRisk } from "./types";
import { getRuntimeConfig } from "./config";

const toolRisks: Record<AgentToolName, ToolRisk> = {
  read_file: "medium",
  write_file: "high",
  web_fetch: "medium",
  run_shell: "high"
};

export function getToolRisk(toolName: AgentToolName): ToolRisk {
  return getRuntimeConfig().tools.get(toolName)?.risk ?? toolRisks[toolName];
}

function getWorkspaceRoot(projectPath?: string): string {
  return projectPath && path.isAbsolute(projectPath) ? projectPath : process.cwd();
}

function isPathOutsideWorkspace(value: unknown, projectPath?: string): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return true;
  }

  const workspaceRoot = getWorkspaceRoot(projectPath);
  const resolvedPath = path.isAbsolute(value) ? path.normalize(value) : path.resolve(workspaceRoot, value);
  const relativePath = path.relative(workspaceRoot, resolvedPath);
  return relativePath.startsWith("..") || path.isAbsolute(relativePath);
}

export function getToolCallRisk(toolCall: ToolCall): ToolRisk {
  return getToolRisk(toolCall.name);
}

export function needsApproval(mode: PermissionMode, toolCall: ToolCall, projectPath?: string): boolean {
  const risk = getToolCallRisk(toolCall);
  const config = getRuntimeConfig();

  if (mode === "full_access") {
    return false;
  }

  if (mode === "request_approval") {
    if (toolCall.name === "web_fetch") {
      return config.permissions.requireApprovalForInternet;
    }

    if (toolCall.name === "write_file") {
      return config.permissions.requireApprovalForFileWrite || isPathOutsideWorkspace(toolCall.arguments.path, projectPath);
    }

    if (toolCall.name === "run_shell") {
      return config.permissions.requireApprovalForShell;
    }

    if (toolCall.name === "read_file") {
      return isPathOutsideWorkspace(toolCall.arguments.path, projectPath);
    }

    return true;
  }

  return risk === "high";
}

export function describePermissionMode(mode: PermissionMode): string {
  if (mode === "request_approval") {
    return "编辑外部文件和使用互联网时始终询问";
  }

  if (mode === "auto_approve") {
    return "仅对检测到的高风险操作请求批准";
  }

  return "可不受限制地访问互联网和本机文件";
}
