import path from "node:path";
import type { AgentToolName, PermissionMode, ToolCall, ToolRisk } from "./types";
import { getRuntimeConfig } from "./config";

const toolRisks: Record<AgentToolName, ToolRisk> = {
  read_file: "medium",
  write_file: "high",
  web_fetch: "medium",
  run_shell: "high",
  git_status: "low",
  git_diff: "medium",
  run_tests: "high",
  open_pull_request: "high"
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

function optionalCwdOutsideWorkspace(value: unknown, projectPath?: string): boolean {
  if (value === undefined || value === null || value === "") return false;
  return isPathOutsideWorkspace(value, projectPath);
}

function commandReferencesOutsideWorkspace(value: unknown, projectPath?: string): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return true;
  }

  const absolutePathMatches = value.matchAll(/(?:^|\s)(\/[^^\s'"`;&|()]+)/g);
  for (const match of absolutePathMatches) {
    if (isPathOutsideWorkspace(match[1], projectPath)) {
      return true;
    }
  }

  return false;
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

  // 自动审批由 server/agent.ts 调用当前模型审核；这里保留静态兜底。
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

    if (toolCall.name === "git_status" || toolCall.name === "git_diff") {
      return optionalCwdOutsideWorkspace(toolCall.arguments.cwd, projectPath);
    }

    if (toolCall.name === "run_tests") {
      if (optionalCwdOutsideWorkspace(toolCall.arguments.cwd, projectPath)) {
        return true;
      }
      return commandReferencesOutsideWorkspace(toolCall.arguments.command ?? "npm run typecheck", projectPath);
    }

    if (toolCall.name === "open_pull_request") {
      return true;
    }

    // Shell 命令：工作目录或显式绝对路径离开项目时需要审批。
    if (toolCall.name === "run_shell") {
      if (toolCall.arguments.cwd && isPathOutsideWorkspace(toolCall.arguments.cwd, projectPath)) {
        return true;
      }
      return commandReferencesOutsideWorkspace(toolCall.arguments.command, projectPath);
    }

    return true;
  }

  return true;
}

export function describePermissionMode(mode: PermissionMode): string {
  if (mode === "request_approval") {
    return "项目内文件和只读 Git 操作直接执行；开 PR、Shell、项目外操作请求审批";
  }

  if (mode === "auto_approve") {
    return "由当前模型自动审核工具风险并决定是否执行";
  }

  return "允许所有工具操作直接执行";
}
