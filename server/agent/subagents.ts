import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkspaceRoot } from "../security/sandbox";

export interface SubagentDefinition {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user" | "builtin";
  prompt: string;
  tools?: string[];
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
}

const readOnlyTools = ["read_file", "list_files", "search_text", "inspect_tree", "project_diagnostics", "git_status", "git_diff"];

/** Safe defaults make multi-agent research useful before a project adds custom definitions. */
export const builtinSubagents: SubagentDefinition[] = [
  {
    name: "researcher",
    description: "快速梳理代码结构、依赖关系和实现方案，返回有依据的摘要。",
    path: "builtin:researcher",
    scope: "builtin",
    prompt: "你是代码研究子 Agent。聚焦分配的范围，先收集证据，再返回关键文件、依赖关系、风险和建议。不要修改文件。",
    tools: readOnlyTools,
    permissionMode: "plan",
    maxTurns: 6
  },
  {
    name: "reviewer",
    description: "审查实现中的缺陷、回归风险和测试缺口，按严重度返回发现。",
    path: "builtin:reviewer",
    scope: "builtin",
    prompt: "你是代码审查子 Agent。以 findings-first 方式工作，优先查找真实 bug、安全问题、回归风险和测试缺口，并尽可能给出文件与行号。不要修改文件。",
    tools: readOnlyTools,
    permissionMode: "plan",
    maxTurns: 7
  },
  {
    name: "debugger",
    description: "独立定位故障根因，验证假设并给出最小修复建议。",
    path: "builtin:debugger",
    scope: "builtin",
    prompt: "你是调试子 Agent。根据代码、日志和测试结果建立可验证假设，定位根因并给出最小修复建议。除非自定义定义明确授权，否则不要修改文件。",
    tools: readOnlyTools,
    permissionMode: "plan",
    maxTurns: 8
  },
  {
    name: "test-analyst",
    description: "分析测试覆盖、失败路径和验证策略，输出可执行的测试清单。",
    path: "builtin:test-analyst",
    scope: "builtin",
    prompt: "你是测试分析子 Agent。检查现有测试和变更影响，识别缺失场景、失败路径与最小验证集。不要修改文件。",
    tools: readOnlyTools,
    permissionMode: "plan",
    maxTurns: 6
  }
];

function frontmatterValue(frontmatter: string, key: string) {
  return frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1]?.trim();
}

function parseTools(value?: string) {
  if (!value) return undefined;
  const tools = value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,\s]+/)
    .map((item) => item.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

export function parseSubagent(filePath: string, content: string, scope: SubagentDefinition["scope"]): SubagentDefinition | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter = match?.[1] ?? "";
  const name = frontmatterValue(frontmatter, "name");
  const description = frontmatterValue(frontmatter, "description");
  if (!name || !description || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) return undefined;
  const maxTurns = Number(frontmatterValue(frontmatter, "maxTurns") ?? frontmatterValue(frontmatter, "max_turns"));
  const bodyPrompt = match ? content.slice(match[0].length).trim() : "";
  return {
    name,
    description,
    path: filePath,
    scope,
    prompt: frontmatterValue(frontmatter, "prompt") ?? bodyPrompt ?? "",
    tools: parseTools(frontmatterValue(frontmatter, "tools")),
    model: frontmatterValue(frontmatter, "model"),
    permissionMode: frontmatterValue(frontmatter, "permissionMode") ?? frontmatterValue(frontmatter, "permission_mode"),
    maxTurns: Number.isFinite(maxTurns) ? Math.max(1, Math.min(12, Math.floor(maxTurns))) : undefined
  };
}

async function scanAgentRoot(root: string, scope: SubagentDefinition["scope"]) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const agents: SubagentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    const parsed = parseSubagent(filePath, await readFile(filePath, "utf8"), scope);
    if (parsed) agents.push(parsed);
  }
  return agents;
}

export async function listSubagents(projectPath?: string) {
  const workspaceRoot = getWorkspaceRoot(projectPath);
  const projectAgents = await scanAgentRoot(path.join(workspaceRoot, ".agent", "agents"), "project");
  const userAgents = await scanAgentRoot(path.join(os.homedir(), ".agent", "agents"), "user");
  // Higher-precedence definitions replace lower-precedence agents by name.
  const agents = new Map<string, SubagentDefinition>();
  for (const agent of builtinSubagents) agents.set(agent.name, agent);
  for (const agent of userAgents) agents.set(agent.name, agent);
  for (const agent of projectAgents) agents.set(agent.name, agent);
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSubagent(name: string, projectPath?: string) {
  return (await listSubagents(projectPath)).find((agent) => agent.name === name);
}
