import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPathInsideWorkspace, getWorkspaceRoot } from "../security/sandbox";

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user" | "builtin";
  allowedTools?: string[];
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
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

async function readSkillInterface(skillDir: string) {
  const metadataPath = path.join(skillDir, "agents", "openai.yaml");
  if (!existsSync(metadataPath)) return {};
  const content = await readFile(metadataPath, "utf8");
  const value = (key: string) => content.match(new RegExp(`^\\s{2}${key}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1]?.trim();
  return {
    displayName: value("display_name"),
    shortDescription: value("short_description"),
    defaultPrompt: value("default_prompt")
  };
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
    if (skill) skills.push({ ...skill, ...(await readSkillInterface(path.dirname(skillPath))) });
  }
  return skills;
}

export async function listSkills(projectPath?: string) {
  const workspaceRoot = getWorkspaceRoot(projectPath);
  const projectSkillRoot = path.join(workspaceRoot, ".agent", "skills");
  const userSkillRoot = path.join(os.homedir(), ".agent", "skills");
  const builtinSkillRoot = path.join(process.cwd(), "config", "skills");
  const localSkills = [
    ...(await scanSkillRoot(projectSkillRoot, "project")),
    ...(await scanSkillRoot(userSkillRoot, "user"))
  ];
  const localNames = new Set(localSkills.map((skill) => skill.name));
  const builtinSkills = (await scanSkillRoot(builtinSkillRoot, "builtin"))
    .filter((skill) => !localNames.has(skill.name));
  return [...localSkills, ...builtinSkills];
}

export async function loadSkillContent(skillPath: string, projectPath?: string) {
  if (skillPath.startsWith(path.join(os.homedir(), ".agent", "skills"))) {
    return readFile(skillPath, "utf8");
  }
  if (skillPath.startsWith(path.join(process.cwd(), "config", "skills"))) {
    return readFile(skillPath, "utf8");
  }
  const resolved = await assertPathInsideWorkspace(skillPath, projectPath);
  return readFile(resolved.canonicalPath, "utf8");
}

const englishStopWords = new Set([
  "and", "are", "asks", "before", "for", "from", "into", "missing", "the", "this", "through", "use", "user", "when", "with"
]);
const shortTechnicalTerms = new Set(["api", "cpu", "pr", "rpc", "ssrf", "tdd", "ui", "ux", "xss"]);
const chineseStopTerms = new Set(["代码", "开发", "检查", "设计", "项目", "问题", "优化", "页面", "测试"]);

function normalizedWords(value: string) {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function triggerDescription(description: string) {
  return description.match(/\bUse\s+(?:for|when)\b([\s\S]*)/i)?.[1] ?? description;
}

export function skillMatchScore(prompt: string, skill: AgentSkill) {
  const lowerPrompt = prompt.toLocaleLowerCase();
  const promptWords = new Set(normalizedWords(prompt));
  let score = 0;

  const namePhrase = skill.name.replace(/-/g, " ");
  if (lowerPrompt.includes(skill.name) || lowerPrompt.includes(namePhrase)) score += 12;

  for (const token of normalizedWords(triggerDescription(skill.description))) {
    const hasChinese = /[\u3400-\u9fff]/u.test(token);
    if (hasChinese) {
      if (token.length < 2) continue;
      if (!chineseStopTerms.has(token) && lowerPrompt.includes(token)) {
        score += Math.min(8, token.length + 2);
        continue;
      }
      if (token.length >= 4) {
        const boundaryTerms = [token.slice(0, 2), token.slice(-2)];
        for (const term of new Set(boundaryTerms)) {
          if (!chineseStopTerms.has(term) && lowerPrompt.includes(term)) score += 2;
        }
      }
      continue;
    }

    if (englishStopWords.has(token)) continue;
    if (token.length < 3 && !shortTechnicalTerms.has(token)) continue;
    if (promptWords.has(token)) score += token.length >= 6 ? 3 : 2;
  }
  return score;
}

export async function activateSkills(prompt: string, projectPath?: string, maxSkills = 3) {
  const skills = await listSkills(projectPath);
  const explicit = [...prompt.matchAll(/\$([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
  const selected: AgentSkill[] = [];

  for (const name of explicit) {
    const skill = skills.find((item) => item.name === name);
    if (skill && !selected.some((item) => item.name === skill.name)) selected.push(skill);
  }

  const rankedSkills = skills
    .filter((skill) => !selected.some((item) => item.name === skill.name))
    .map((skill) => ({ skill, score: skillMatchScore(prompt, skill) }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  for (const { skill } of rankedSkills) {
    if (selected.length >= maxSkills) break;
    selected.push(skill);
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
