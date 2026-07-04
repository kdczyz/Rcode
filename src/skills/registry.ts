import { builtinSkills } from "./builtinSkills";
import { mainstreamSkills } from "./mainstreamSkillPacks";
import type { AgentSkill, SkillCategory, SkillRegistrySnapshot, SkillSearchOptions } from "./types";

const allSkills = dedupeSkills([...builtinSkills, ...mainstreamSkills]);
const skillsById = new Map<string, AgentSkill>(allSkills.map((skill) => [skill.id, skill]));

function dedupeSkills(skills: AgentSkill[]) {
  const seen = new Set<string>();
  const result: AgentSkill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    result.push(skill);
  }
  return result;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function matchesKeyword(skill: AgentSkill, keyword: string) {
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return true;

  const haystack = [
    skill.id,
    skill.name,
    skill.summary,
    skill.description,
    skill.category,
    ...skill.trigger.keywords,
    ...skill.capabilities.map((capability) => capability.label),
    ...skill.capabilities.map((capability) => capability.description)
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(normalizedKeyword);
}

export function listSkills(options: SkillSearchOptions = {}) {
  return allSkills.filter((skill) => {
    if (!options.includeDisabled && !skill.enabledByDefault) return false;
    if (options.category && skill.category !== options.category) return false;
    if (options.keyword && !matchesKeyword(skill, options.keyword)) return false;
    return true;
  });
}

export function getSkillById(id: string) {
  return skillsById.get(id);
}

export function listSkillCategories() {
  return [...new Set(allSkills.map((skill) => skill.category))] as SkillCategory[];
}

export function findSkillsForPrompt(prompt: string) {
  const normalizedPrompt = normalize(prompt);
  if (!normalizedPrompt) return [];

  return listSkills().filter((skill) => {
    return skill.trigger.keywords.some((keyword) => normalizedPrompt.includes(normalize(keyword)));
  });
}

export function getSkillSystemHints(skills: AgentSkill[]) {
  return skills.map((skill) => `- ${skill.name}: ${skill.systemHint}`).join("\n");
}

export function getSkillRegistrySnapshot(): SkillRegistrySnapshot {
  const enabledSkills = allSkills.filter((skill) => skill.enabledByDefault);
  return {
    total: allSkills.length,
    enabled: enabledSkills.length,
    categories: listSkillCategories(),
    skills: enabledSkills
  };
}
