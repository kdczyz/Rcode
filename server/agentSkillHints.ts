export interface AgentSkillHint {
  id: string;
  name: string;
  keywords: string[];
  hint: string;
}

const skillHints: AgentSkillHint[] = [
  {
    id: "implementation-planner",
    name: "实现方案规划",
    keywords: ["实现方案", "技术方案", "规划", "拆解", "计划", "怎么做"],
    hint: "先明确目标、影响范围、执行步骤和验收标准，再进入代码修改。"
  },
  {
    id: "repo-context",
    name: "项目上下文理解",
    keywords: ["项目", "仓库", "结构", "入口", "上下文", "文件"],
    hint: "优先读取与任务相关的少量关键文件，避免无目的扩大上下文。"
  },
  {
    id: "feature-builder",
    name: "功能开发",
    keywords: ["新增功能", "开发", "实现", "接入", "页面", "接口"],
    hint: "先理解现有结构，再用最小必要改动实现功能，并说明变更点。"
  },
  {
    id: "bug-investigator",
    name: "Bug 追踪修复",
    keywords: ["bug", "报错", "异常", "修复", "失败", "不生效"],
    hint: "先定位根因，再做最小修复，最后给出验证方式。"
  },
  {
    id: "code-reviewer",
    name: "代码审查",
    keywords: ["审查", "review", "检查", "质量", "风险", "问题"],
    hint: "优先指出高影响问题，每个问题都给出可执行修复建议。"
  },
  {
    id: "test-runner",
    name: "测试与构建反馈",
    keywords: ["测试", "构建", "typecheck", "build", "lint", "CI"],
    hint: "选择与验证相关的非交互式检查方式，并摘要关键输出。"
  },
  {
    id: "git-workflow",
    name: "Git / PR 协作",
    keywords: ["git", "commit", "提交", "PR", "diff", "分支"],
    hint: "先总结改动，再组织提交或 PR 说明，不主动执行不可逆版本操作。"
  },
  {
    id: "provider-configurator",
    name: "模型 Provider 配置",
    keywords: ["模型", "provider", "OpenAI-compatible", "OpenRouter", "MiMo", "Base URL"],
    hint: "强调 MiMo 是默认通用免费模型入口，同时保留用户自定义模型自由。"
  },
  {
    id: "security-auditor",
    name: "安全审查",
    keywords: ["安全", "漏洞", "权限", "密钥", "注入", "风险"],
    hint: "安全相关任务要保守，遇到不确定权限边界时请求人工确认。"
  },
  {
    id: "docs-writer",
    name: "文档生成",
    keywords: ["文档", "README", "说明", "roadmap", "规格", "设计"],
    hint: "文档要服务 Rcode 对标主流 coding agent 的产品定位。"
  }
];

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export function findAgentSkillHints(prompt: string, limit = 6) {
  const normalizedPrompt = normalize(prompt);
  if (!normalizedPrompt) return [];

  return skillHints
    .filter((skill) => skill.keywords.some((keyword) => normalizedPrompt.includes(normalize(keyword))))
    .slice(0, limit);
}

export function formatAgentSkillHints(skills: AgentSkillHint[]) {
  return skills.map((skill) => `- ${skill.name}: ${skill.hint}`).join("\n");
}

export function listAgentSkillHints() {
  return [...skillHints];
}
