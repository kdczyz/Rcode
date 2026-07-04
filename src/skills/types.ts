export type SkillCategory =
  | "planning"
  | "code"
  | "review"
  | "test"
  | "git"
  | "docs"
  | "provider"
  | "workflow";

export type SkillRiskLevel = "low" | "medium" | "high";

export interface SkillTrigger {
  keywords: string[];
  description: string;
}

export interface SkillCapability {
  id: string;
  label: string;
  description: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  category: SkillCategory;
  summary: string;
  description: string;
  trigger: SkillTrigger;
  capabilities: SkillCapability[];
  requiredTools: string[];
  riskLevel: SkillRiskLevel;
  systemHint: string;
  enabledByDefault: boolean;
}

export interface SkillSearchOptions {
  category?: SkillCategory;
  keyword?: string;
  includeDisabled?: boolean;
}

export interface SkillRegistrySnapshot {
  total: number;
  enabled: number;
  categories: SkillCategory[];
  skills: AgentSkill[];
}
