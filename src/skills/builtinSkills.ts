import type { AgentSkill } from "./types";

export const builtinSkills: AgentSkill[] = [
  {
    id: "task-planner",
    name: "任务规划",
    category: "planning",
    summary: "把用户目标拆成可执行步骤。",
    description: "适合复杂开发任务，在动手前先形成目标、约束、步骤和验收标准。",
    trigger: {
      keywords: ["规划", "计划", "拆解", "实现", "重构", "开发"],
      description: "当用户提出多步骤开发目标时触发。"
    },
    capabilities: [
      { id: "goal", label: "目标识别", description: "提取用户真正想完成的产品或工程目标。" },
      { id: "steps", label: "步骤拆解", description: "把目标拆成可执行的开发步骤。" },
      { id: "acceptance", label: "验收标准", description: "生成可检查的完成标准。" }
    ],
    requiredTools: [],
    riskLevel: "low",
    systemHint: "先用简短步骤规划任务，再进入代码或工具执行。",
    enabledByDefault: true
  },
  {
    id: "repo-context",
    name: "项目上下文理解",
    category: "code",
    summary: "理解项目结构、关键文件和已有实现。",
    description: "适合接手新任务前快速识别项目结构、入口文件、配置和相关模块。",
    trigger: {
      keywords: ["项目", "仓库", "结构", "文件", "入口", "上下文"],
      description: "当任务需要理解现有代码库时触发。"
    },
    capabilities: [
      { id: "structure", label: "结构识别", description: "识别项目目录与关键文件。" },
      { id: "entry", label: "入口定位", description: "定位前端、后端或配置入口。" },
      { id: "context", label: "上下文摘要", description: "总结与任务相关的代码上下文。" }
    ],
    requiredTools: ["read_file"],
    riskLevel: "medium",
    systemHint: "先读取必要文件，再总结项目上下文，不要无目的扩大范围。",
    enabledByDefault: true
  },
  {
    id: "code-editor",
    name: "代码编辑",
    category: "code",
    summary: "根据任务修改或创建项目文件。",
    description: "适合实现功能、修复问题、调整配置和补充组件。",
    trigger: {
      keywords: ["修改", "新增", "实现", "修复", "调整", "接入"],
      description: "当用户要求改变项目文件时触发。"
    },
    capabilities: [
      { id: "read-before-edit", label: "先读后改", description: "编辑前先理解已有内容。" },
      { id: "complete-write", label: "完整写入", description: "生成完整文件内容或完整新增模块。" },
      { id: "diff-aware", label: "差异意识", description: "改动后关注文件 diff 和影响范围。" }
    ],
    requiredTools: ["read_file", "write_file"],
    riskLevel: "high",
    systemHint: "编辑前先确认目标文件和影响范围，改动后说明变更点。",
    enabledByDefault: true
  },
  {
    id: "code-reviewer",
    name: "代码审查",
    category: "review",
    summary: "审查实现质量、风险和遗漏。",
    description: "适合在完成修改后检查类型、逻辑、边界、命名和产品定位是否一致。",
    trigger: {
      keywords: ["检查", "审查", "review", "风险", "问题", "质量"],
      description: "当用户要求检查代码或改动质量时触发。"
    },
    capabilities: [
      { id: "quality", label: "质量检查", description: "识别可维护性和一致性问题。" },
      { id: "risk", label: "风险识别", description: "识别潜在破坏性改动或边界问题。" },
      { id: "next-actions", label: "后续建议", description: "给出下一步优化方向。" }
    ],
    requiredTools: ["read_file"],
    riskLevel: "medium",
    systemHint: "优先指出高影响问题，再给出可执行修复建议。",
    enabledByDefault: true
  },
  {
    id: "test-runner",
    name: "测试与构建反馈",
    category: "test",
    summary: "运行或解释测试、类型检查和构建结果。",
    description: "适合验证改动是否破坏项目，并把错误转成修复建议。",
    trigger: {
      keywords: ["测试", "构建", "typecheck", "build", "报错", "验证"],
      description: "当用户要求验证项目状态时触发。"
    },
    capabilities: [
      { id: "command-choice", label: "命令选择", description: "根据项目脚本选择合适验证方式。" },
      { id: "error-summary", label: "错误摘要", description: "把输出转成可理解的问题列表。" },
      { id: "fix-plan", label: "修复计划", description: "给出修复步骤。" }
    ],
    requiredTools: ["run_shell"],
    riskLevel: "high",
    systemHint: "只选择与验证相关的非交互式命令，并摘要关键输出。",
    enabledByDefault: true
  },
  {
    id: "git-workflow",
    name: "Git 工作流",
    category: "git",
    summary: "辅助查看改动、组织提交和生成提交说明。",
    description: "适合在完成任务后整理变更、生成 commit message 或 PR 摘要。",
    trigger: {
      keywords: ["git", "提交", "commit", "分支", "diff", "PR"],
      description: "当任务涉及版本管理或改动总结时触发。"
    },
    capabilities: [
      { id: "change-summary", label: "变更总结", description: "总结文件级别改动。" },
      { id: "commit-message", label: "提交说明", description: "生成清晰 commit message。" },
      { id: "pr-summary", label: "PR 摘要", description: "生成面向 review 的说明。" }
    ],
    requiredTools: ["run_shell"],
    riskLevel: "high",
    systemHint: "先总结改动，再建议提交，不主动执行不可逆版本操作。",
    enabledByDefault: true
  },
  {
    id: "provider-configurator",
    name: "模型 Provider 配置",
    category: "provider",
    summary: "帮助用户接入 MiMo、OpenAI-compatible、OpenRouter 或自定义模型服务。",
    description: "适合配置模型、解释 provider 字段、选择默认模型和检查兼容能力。",
    trigger: {
      keywords: ["模型", "provider", "OpenAI-compatible", "OpenRouter", "MiMo", "Base URL"],
      description: "当用户讨论模型接入或设置页时触发。"
    },
    capabilities: [
      { id: "preset", label: "预设选择", description: "根据用户目标选择 provider 预设。" },
      { id: "capability", label: "能力声明", description: "说明工具调用、流式输出等能力。" },
      { id: "migration", label: "迁移指导", description: "从默认模型迁移到用户自定义模型。" }
    ],
    requiredTools: ["read_file", "write_file"],
    riskLevel: "medium",
    systemHint: "强调 MiMo 是默认通用免费模型入口，不是产品定位上限。",
    enabledByDefault: true
  },
  {
    id: "docs-writer",
    name: "文档生成",
    category: "docs",
    summary: "生成产品说明、使用说明、roadmap 和设计文档。",
    description: "适合把功能定位和技术决策沉淀为可维护文档。",
    trigger: {
      keywords: ["文档", "说明", "README", "roadmap", "规格", "设计"],
      description: "当用户要求写产品或工程文档时触发。"
    },
    capabilities: [
      { id: "positioning", label: "定位文档", description: "沉淀产品定位。" },
      { id: "spec", label: "规格文档", description: "整理功能规格。" },
      { id: "roadmap", label: "路线图", description: "规划阶段性目标。" }
    ],
    requiredTools: ["write_file"],
    riskLevel: "medium",
    systemHint: "文档要服务 Rcode 对标主流 coding agent 的定位。",
    enabledByDefault: true
  }
];
