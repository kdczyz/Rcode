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

  // 完全访问：完全控制，不需要任何审批
  if (mode === "full_access") {
    return false;
  }

  // 自动审批：AI 思考判定风险，高风险操作需要审批，低风险直接通过
  if (mode === "auto_approve") {
    return risk === "high";
  }

  // 请求批准：当前项目内操作自动通过，项目外操作需要手动审批
  if (mode === "request_approval") {
    // 网络请求始终在项目外，需要审批
    if (toolCall.name === "web_fetch") {
      return true;
    }

    // 文件读写：检查目标路径是否在项目内
    if (toolCall.name === "write_file" || toolCall.name === "read_file") {
      return isPathOutsideWorkspace(toolCall.arguments.path, projectPath);
    }

    // Shell 命令：无法可靠判断操作范围，需要审批
    if (toolCall.name === "run_shell") {
      return true;
    }

    return true;
  }

  return true;
}

export function describePermissionMode(mode: PermissionMode): string {
  if (mode === "request_approval") {
    return "当前项目内操作自动通过，项目外操作需手动审批";
  }

  if (mode === "auto_approve") {
    return "AI 自动判定风险，高风险需审批，低风险直接通过";
  }

  return "完全控制，不需要任何审批";
}
