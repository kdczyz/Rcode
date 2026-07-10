import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPathInsideWorkspace, getWorkspaceRoot } from "./sandbox";

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user";
  allowedTools?: string[];
}

function parseSkillMarkdown(filePath: string, content: string, scope: AgentSkill["scope"]): AgentSkill | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1] ?? "";
  const name = frontmatter.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
  const allowedTools = frontmatter.match(/^allowed_tools:\s*["']?(.+?)["']?\s*$/m)?.[1]
    ?.split(/[,\s]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (!name || !description) return undefined;
  return { name, description, path: filePath, scope, allowedTools };
}

async function scanSkillRoot(root: string, scope: AgentSkill["scope"]) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const skills: AgentSkill[] = [];
  for (const entry of entries) {
    const skillPath = path.join(root, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(skillPath)) continue;
    const content = await readFile(skillPath, "utf8");
    const skill = parseSkillMarkdown(skillPath, content, scope);
    if (skill) skills.push(skill);
  }
  return skills;
}

export async function listSkills(projectPath?: string) {
  const workspaceRoot = getWorkspaceRoot(projectPath);
  const projectSkillRoot = path.join(workspaceRoot, ".agent", "skills");
  const userSkillRoot = path.join(os.homedir(), ".agent", "skills");
  return [
    ...(await scanSkillRoot(projectSkillRoot, "project")),
    ...(await scanSkillRoot(userSkillRoot, "user"))
  ];
}

export async function loadSkillContent(skillPath: string, projectPath?: string) {
  if (skillPath.startsWith(path.join(os.homedir(), ".agent", "skills"))) {
    return readFile(skillPath, "utf8");
  }
  const resolved = await assertPathInsideWorkspace(skillPath, projectPath);
  return readFile(resolved.canonicalPath, "utf8");
}

function descriptionMatches(prompt: string, skill: AgentSkill) {
  const lowerPrompt = prompt.toLowerCase();
  const words = skill.description
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length >= 5);
  return words.length > 0 && words.some((word) => lowerPrompt.includes(word));
}

export async function activateSkills(prompt: string, projectPath?: string, maxSkills = 3) {
  const skills = await listSkills(projectPath);
  const explicit = [...prompt.matchAll(/\$([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
  const selected: AgentSkill[] = [];

  for (const name of explicit) {
    const skill = skills.find((item) => item.name === name);
    if (skill && !selected.some((item) => item.name === skill.name)) selected.push(skill);
  }

  for (const skill of skills) {
    if (selected.length >= maxSkills) break;
    if (!selected.some((item) => item.name === skill.name) && descriptionMatches(prompt, skill)) {
      selected.push(skill);
    }
  }

  const loaded = [];
  for (const skill of selected.slice(0, maxSkills)) {
    loaded.push({
      ...skill,
      content: (await loadSkillContent(skill.path, projectPath)).slice(0, 12000)
    });
  }
  return loaded;
}
