import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { listMemories } from "./localDatabase";
import { getWorkspaceRoot } from "./sandbox";
import { activateSkills } from "./skills";
import type { AgentMessage } from "./types";

async function readIfExists(filePath: string, maxChars: number) {
  if (!existsSync(filePath)) return "";
  const content = await readFile(filePath, "utf8");
  return content.slice(0, maxChars);
}

async function readRuleFiles(projectPath: string) {
  const rulesDir = path.join(projectPath, ".agent", "rules");
  if (!existsSync(rulesDir)) return "";
  const entries = await readdir(rulesDir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(rulesDir, entry.name);
    parts.push(`Rule ${entry.name}:\n${await readIfExists(filePath, 4000)}`);
  }
  return parts.join("\n\n").slice(0, 12000);
}

export async function buildProjectContext(projectPath?: string, prompt = "") {
  const workspaceRoot = getWorkspaceRoot(projectPath);
  const agentsMd = await readIfExists(path.join(workspaceRoot, "AGENTS.md"), 8000);
  const rules = await readRuleFiles(workspaceRoot);
  const memories = listMemories(workspaceRoot, 12) as Array<{ kind: string; content: string }>;
  const memoryText = memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n").slice(0, 6000);
  const skills = prompt ? await activateSkills(prompt, projectPath) : [];
  const skillText = skills.map((skill) => [
    `Skill $${skill.name}: ${skill.description}`,
    skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
    skill.content
  ].filter(Boolean).join("\n")).join("\n\n").slice(0, 16000);
  const sections = [
    agentsMd ? `AGENTS.md guidance:\n${agentsMd}` : "",
    rules ? `.agent/rules guidance:\n${rules}` : "",
    memoryText ? `Project memory:\n${memoryText}` : "",
    skillText ? `Activated skills:\n${skillText}` : ""
  ].filter(Boolean);
  return sections.join("\n\n");
}

export function compactMessagesForContext(messages: AgentMessage[], maxChars = 60000): AgentMessage[] {
  let total = 0;
  const kept: AgentMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const content = message.role === "tool" && message.content.length > 2500
      ? `${message.content.slice(0, 2500)}\n[Tool output summarized for context budget.]`
      : message.content;
    total += content.length;
    if (total > maxChars) break;
    kept.unshift({ ...message, content });
  }
  if (kept.length === messages.length) return kept;
  return [
    {
      role: "system",
      content: `Earlier conversation (${messages.length - kept.length} messages) was compacted to preserve context budget. Use audit/artifacts if exact historical tool output is needed.`
    },
    ...kept
  ];
}
