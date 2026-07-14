import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkspaceRoot } from "../security/sandbox";

export interface SubagentDefinition {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user";
  tools?: string[];
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
}

function frontmatterValue(frontmatter: string, key: string) {
  return frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1]?.trim();
}

function parseSubagent(filePath: string, content: string, scope: SubagentDefinition["scope"]): SubagentDefinition | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1] ?? "";
  const name = frontmatterValue(frontmatter, "name");
  const description = frontmatterValue(frontmatter, "description");
  if (!name || !description) return undefined;
  const tools = frontmatterValue(frontmatter, "tools")?.split(/[,\s]+/).filter(Boolean);
  const maxTurns = Number(frontmatterValue(frontmatter, "maxTurns") ?? frontmatterValue(frontmatter, "max_turns"));
  return {
    name,
    description,
    path: filePath,
    scope,
    tools,
    model: frontmatterValue(frontmatter, "model"),
    permissionMode: frontmatterValue(frontmatter, "permissionMode") ?? frontmatterValue(frontmatter, "permission_mode"),
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : undefined
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
  return [
    ...(await scanAgentRoot(path.join(workspaceRoot, ".agent", "agents"), "project")),
    ...(await scanAgentRoot(path.join(os.homedir(), ".agent", "agents"), "user"))
  ];
}
