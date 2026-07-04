import type { AgentSkill, SkillCategory } from "./types";

export interface SkillPackGroup {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  skills: AgentSkill[];
}

export const mainstreamSkillPackGroups: SkillPackGroup[] = [
  {
    id: "planning-and-product",
    name: "规划与产品组",
    description: "面向需求拆解、实现计划、任务排期和产品决策的通用 agent skills。",
    category: "planning",
    skills: [
      {
        id: "implementation-planner",
        name: "实现方案规划",
        category: "planning",
        summary: "把需求拆成技术方案、影响范围和执行步骤。",
        description: "适合功能开发、重构、迁移和跨文件改动，先产出方案再执行。",
        trigger: {
          keywords: ["实现方案", "技术方案", "怎么做", "拆解", "计划", "规划"],
          description: "当用户提出复杂开发目标或不确定实施路径时触发。"
        },
        capabilities: [
          { id: "scope", label: "范围识别", description: "识别涉及的模块、文件和配置。" },
          { id: "plan", label: "执行计划", description: "生成分阶段执行步骤。" },
          { id: "acceptance", label: "验收条件", description: "定义完成后的检查标准。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "先规划再动手，明确影响范围、步骤和验收标准。",
        enabledByDefault: true
      },
      {
        id: "issue-to-task-brief",
        name: "Issue 转任务简报",
        category: "planning",
        summary: "把 issue、需求描述或聊天内容整理成可执行开发任务。",
        description: "适合把模糊描述转成目标、上下文、约束、步骤和风险。",
        trigger: {
          keywords: ["issue", "需求", "任务", "简报", "整理", "todo"],
          description: "当用户给出 issue 或需求片段时触发。"
        },
        capabilities: [
          { id: "goal", label: "目标提炼", description: "提炼用户真正要交付的结果。" },
          { id: "constraints", label: "约束整理", description: "整理边界、限制和依赖。" },
          { id: "checklist", label: "任务清单", description: "生成可执行 checklist。" }
        ],
        requiredTools: [],
        riskLevel: "low",
        systemHint: "把模糊需求整理成清晰任务，不急于修改代码。",
        enabledByDefault: true
      },
      {
        id: "multi-agent-work-splitter",
        name: "多 Agent 任务拆分",
        category: "planning",
        summary: "把大任务拆成可并行处理的子任务。",
        description: "适合未来多 agent、后台任务或分工执行场景。",
        trigger: {
          keywords: ["多 agent", "并行", "分工", "子任务", "拆分"],
          description: "当任务明显可以并行或需要多角色协作时触发。"
        },
        capabilities: [
          { id: "roles", label: "角色划分", description: "划分 planner、coder、reviewer、tester 等角色。" },
          { id: "parallel", label: "并行拆分", description: "把任务拆成相互独立的执行单元。" },
          { id: "merge", label: "结果合并", description: "定义合并与冲突处理方式。" }
        ],
        requiredTools: [],
        riskLevel: "low",
        systemHint: "把复杂任务拆成可并行的角色和子任务，最后给出合并策略。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "coding-and-refactor",
    name: "编码与重构组",
    description: "覆盖日常功能开发、bug 修复、重构、迁移和前后端集成。",
    category: "code",
    skills: [
      {
        id: "feature-builder",
        name: "功能开发",
        category: "code",
        summary: "根据需求实现跨文件功能。",
        description: "适合新增页面、接口、状态、组件、工具函数或配置。",
        trigger: {
          keywords: ["新增功能", "开发", "实现", "接入", "页面", "接口"],
          description: "当用户要求实现一个新能力时触发。"
        },
        capabilities: [
          { id: "context", label: "上下文读取", description: "先读相关文件理解项目约定。" },
          { id: "implementation", label: "功能实现", description: "修改或新增必要文件。" },
          { id: "summary", label: "变更总结", description: "说明实现路径和影响范围。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "先理解现有结构，再用最小必要改动实现功能。",
        enabledByDefault: true
      },
      {
        id: "bug-investigator",
        name: "Bug 追踪修复",
        category: "code",
        summary: "根据报错、症状或复现信息定位并修复问题。",
        description: "适合运行时错误、类型错误、构建失败、逻辑异常和 UI 异常。",
        trigger: {
          keywords: ["bug", "报错", "异常", "修复", "不生效", "失败"],
          description: "当用户提供错误现象或失败输出时触发。"
        },
        capabilities: [
          { id: "trace", label: "链路追踪", description: "沿调用链定位可能原因。" },
          { id: "fix", label: "最小修复", description: "优先做局部且可验证的修复。" },
          { id: "verify", label: "验证建议", description: "给出修复后的验证方式。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "先定位根因，再做最小修复，并说明验证方式。",
        enabledByDefault: true
      },
      {
        id: "refactor-assistant",
        name: "重构助手",
        category: "code",
        summary: "改善代码结构、命名、复用和边界。",
        description: "适合组件拆分、函数提取、配置整理和架构层次优化。",
        trigger: {
          keywords: ["重构", "优化结构", "拆分", "整理", "抽离", "复用"],
          description: "当用户希望提升代码质量但不改变功能时触发。"
        },
        capabilities: [
          { id: "preserve", label: "行为保持", description: "尽量不改变用户可见行为。" },
          { id: "structure", label: "结构优化", description: "拆分职责并减少重复。" },
          { id: "migration", label: "迁移说明", description: "说明改动前后结构差异。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "重构时优先保持行为不变，明确说明改动边界。",
        enabledByDefault: true
      },
      {
        id: "frontend-polisher",
        name: "前端体验打磨",
        category: "code",
        summary: "优化界面层级、状态反馈、空态和交互文案。",
        description: "适合本地 agent 控制台、设置页、工具时间线和 diff 面板体验优化。",
        trigger: {
          keywords: ["前端", "UI", "界面", "体验", "样式", "交互"],
          description: "当用户要求优化界面或产品体验时触发。"
        },
        capabilities: [
          { id: "layout", label: "布局整理", description: "改善信息结构和视觉层级。" },
          { id: "state", label: "状态反馈", description: "补充加载、空态、错误和成功状态。" },
          { id: "copy", label: "产品文案", description: "统一 agent 产品定位文案。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "前端改动要服务 Rcode 主流 coding agent 定位，优先清晰和可用。",
        enabledByDefault: true
      },
      {
        id: "api-integration-builder",
        name: "API 集成开发",
        category: "code",
        summary: "补齐前后端 API、状态字段和数据结构。",
        description: "适合把后端 registry、skill、provider、settings 等能力暴露给前端。",
        trigger: {
          keywords: ["API", "接口", "前后端", "server", "endpoint", "接入"],
          description: "当任务涉及前后端数据联通时触发。"
        },
        capabilities: [
          { id: "contract", label: "契约设计", description: "定义请求响应结构。" },
          { id: "endpoint", label: "接口实现", description: "补充后端接口与前端消费。" },
          { id: "compat", label: "兼容处理", description: "避免破坏现有调用。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "先定义稳定数据契约，再接入前后端，保持向后兼容。",
        enabledByDefault: true
      },
      {
        id: "dependency-updater",
        name: "依赖升级维护",
        category: "code",
        summary: "分析依赖、升级影响和兼容风险。",
        description: "适合更新框架、工具链、类型包或安全补丁前的影响评估。",
        trigger: {
          keywords: ["依赖", "升级", "版本", "package", "npm", "兼容"],
          description: "当用户要更新依赖或处理版本问题时触发。"
        },
        capabilities: [
          { id: "impact", label: "影响评估", description: "识别升级影响范围。" },
          { id: "plan", label: "升级计划", description: "给出分步升级路径。" },
          { id: "verify", label: "验证清单", description: "生成升级后的检查项。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "升级依赖前先评估破坏性变化和验证方式。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "review-quality-security",
    name: "审查质量与安全组",
    description: "覆盖 PR 审查、可维护性、性能、可访问性和安全风险扫描。",
    category: "review",
    skills: [
      {
        id: "pr-reviewer",
        name: "PR / Diff 审查",
        category: "review",
        summary: "审查 diff 中最值得先处理的问题。",
        description: "适合提交前检查、PR 自查、代码评审和回归风险识别。",
        trigger: {
          keywords: ["PR", "diff", "review", "审查", "提交前", "检查改动"],
          description: "当用户要求审查改动或准备 PR 时触发。"
        },
        capabilities: [
          { id: "priority", label: "优先级排序", description: "优先指出高影响问题。" },
          { id: "actionable", label: "可执行建议", description: "每个问题给出具体修复方向。" },
          { id: "no-touch", label: "不主动修改", description: "审查阶段默认只报告问题。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "像主流 agent 的本地 review 一样，输出优先级明确、可执行的 findings。",
        enabledByDefault: true
      },
      {
        id: "security-auditor",
        name: "安全审查",
        category: "review",
        summary: "检查凭证泄露、危险边界、注入和权限风险。",
        description: "适合 agent 工具、provider 配置、本地执行、网络访问和依赖相关代码。",
        trigger: {
          keywords: ["安全", "漏洞", "权限", "密钥", "风险", "注入"],
          description: "当用户关注安全或改动涉及敏感边界时触发。"
        },
        capabilities: [
          { id: "secrets", label: "凭证检查", description: "识别硬编码密钥和泄露风险。" },
          { id: "boundary", label: "边界检查", description: "检查路径、网络和权限边界。" },
          { id: "mitigation", label: "缓解建议", description: "给出安全修复建议。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "安全审查要保守，遇到不确定边界时建议人工确认。",
        enabledByDefault: true
      },
      {
        id: "performance-reviewer",
        name: "性能审查",
        category: "review",
        summary: "检查渲染、循环、IO、缓存和大文件处理风险。",
        description: "适合前端渲染、server 流式响应、diff 计算和工具输出处理。",
        trigger: {
          keywords: ["性能", "慢", "卡", "优化", "渲染", "缓存"],
          description: "当用户要求性能优化或怀疑卡顿时触发。"
        },
        capabilities: [
          { id: "hotspot", label: "热点识别", description: "找出潜在耗时路径。" },
          { id: "render", label: "渲染优化", description: "减少不必要渲染或大对象传递。" },
          { id: "memory", label: "内存风险", description: "识别大文本、diff、日志带来的内存压力。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "先指出真实性能瓶颈，再建议低风险优化。",
        enabledByDefault: true
      },
      {
        id: "accessibility-auditor",
        name: "可访问性审查",
        category: "review",
        summary: "检查键盘、语义、标签、对比和状态提示。",
        description: "适合设置页、面板、按钮、审批卡片、工具时间线和 diff UI。",
        trigger: {
          keywords: ["可访问性", "accessibility", "a11y", "键盘", "aria", "无障碍"],
          description: "当前端 UI 需要无障碍检查时触发。"
        },
        capabilities: [
          { id: "semantic", label: "语义检查", description: "检查标签和结构语义。" },
          { id: "keyboard", label: "键盘操作", description: "检查可聚焦和快捷操作。" },
          { id: "state", label: "状态提示", description: "检查加载、错误、审批等状态可感知。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "审查 UI 时加入 a11y 视角，尤其关注键盘和状态提示。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "testing-and-ci",
    name: "测试与 CI 组",
    description: "覆盖单测、端到端测试、失败定位、lint/typecheck 和 CI 修复。",
    category: "test",
    skills: [
      {
        id: "unit-test-generator",
        name: "单元测试生成",
        category: "test",
        summary: "为关键逻辑和工具函数生成单元测试方案。",
        description: "适合权限判断、provider registry、skill 匹配、diff 计算等纯逻辑。",
        trigger: {
          keywords: ["单测", "unit test", "测试用例", "覆盖", "mock"],
          description: "当用户要增加或更新单元测试时触发。"
        },
        capabilities: [
          { id: "cases", label: "用例设计", description: "覆盖正常、边界和错误场景。" },
          { id: "mock", label: "Mock 策略", description: "设计依赖隔离方式。" },
          { id: "coverage", label: "覆盖建议", description: "指出关键覆盖缺口。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "测试应围绕真实行为和边界条件，不只追求快照覆盖。",
        enabledByDefault: true
      },
      {
        id: "e2e-test-planner",
        name: "端到端测试规划",
        category: "test",
        summary: "设计用户路径级别的端到端测试。",
        description: "适合 agent 会话、审批、工具结果、设置页和 provider 切换路径。",
        trigger: {
          keywords: ["e2e", "端到端", "流程测试", "用户路径", "回归"],
          description: "当功能需要按完整用户流程验证时触发。"
        },
        capabilities: [
          { id: "journey", label: "路径设计", description: "定义关键用户路径。" },
          { id: "assertions", label: "断言设计", description: "定义可检查结果。" },
          { id: "fixtures", label: "测试数据", description: "规划稳定测试数据。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "端到端测试要围绕关键路径，避免过度脆弱。",
        enabledByDefault: true
      },
      {
        id: "ci-failure-fixer",
        name: "CI 失败修复",
        category: "test",
        summary: "分析构建、lint、类型检查或测试失败并给出修复。",
        description: "适合把长输出归纳成根因、影响和修复步骤。",
        trigger: {
          keywords: ["CI", "lint", "typecheck", "构建失败", "测试失败", "pipeline"],
          description: "当用户贴出 CI 或本地验证失败时触发。"
        },
        capabilities: [
          { id: "parse", label: "输出解析", description: "从日志中提取关键错误。" },
          { id: "root-cause", label: "根因判断", description: "区分真正错误和噪声。" },
          { id: "fix", label: "修复建议", description: "给出最小修复路径。" }
        ],
        requiredTools: ["read_file", "write_file", "run_shell"],
        riskLevel: "high",
        systemHint: "处理 CI 失败时先总结根因，再建议最小修复和验证命令。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "git-pr-collaboration",
    name: "Git / PR 协作组",
    description: "覆盖分支、提交、PR 摘要、review 回复和发布说明。",
    category: "git",
    skills: [
      {
        id: "commit-message-writer",
        name: "提交信息生成",
        category: "git",
        summary: "根据改动生成清晰 commit message。",
        description: "适合完成一组变更后总结意图和影响范围。",
        trigger: {
          keywords: ["commit message", "提交信息", "提交说明", "commit"],
          description: "当用户需要组织提交时触发。"
        },
        capabilities: [
          { id: "intent", label: "意图总结", description: "总结本次改动目的。" },
          { id: "scope", label: "范围说明", description: "说明涉及模块。" },
          { id: "format", label: "格式化", description: "生成 conventional commit 风格文案。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "生成提交信息时突出用户意图和代码实际变化。",
        enabledByDefault: true
      },
      {
        id: "pr-description-writer",
        name: "PR 描述生成",
        category: "git",
        summary: "生成包含摘要、测试和风险的 PR 描述。",
        description: "适合准备 pull request 或变更说明。",
        trigger: {
          keywords: ["PR 描述", "pull request", "变更说明", "reviewer"],
          description: "当用户准备提交 review 时触发。"
        },
        capabilities: [
          { id: "summary", label: "摘要", description: "说明本 PR 做了什么。" },
          { id: "tests", label: "验证", description: "列出已做或建议验证。" },
          { id: "risks", label: "风险", description: "说明潜在影响和 reviewer 关注点。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "PR 描述要方便 reviewer 快速理解变更、验证和风险。",
        enabledByDefault: true
      },
      {
        id: "review-response-assistant",
        name: "Review 回复助手",
        category: "git",
        summary: "把 review 意见转成修复计划或回复草稿。",
        description: "适合处理 reviewer comments、变更请求和争议点。",
        trigger: {
          keywords: ["review 意见", "回复 reviewer", "comments", "修改意见", "code review"],
          description: "当用户要处理审查反馈时触发。"
        },
        capabilities: [
          { id: "classify", label: "意见分类", description: "区分必须修、可讨论和误报。" },
          { id: "fix-plan", label: "修复计划", description: "生成对应修改步骤。" },
          { id: "reply", label: "回复草稿", description: "生成礼貌清晰的回复。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "high",
        systemHint: "先判断 review 意见类型，再给出修复或回复。",
        enabledByDefault: true
      },
      {
        id: "release-note-writer",
        name: "发布说明生成",
        category: "docs",
        summary: "把一组变更整理成 release notes 或 changelog。",
        description: "适合版本发布、功能更新和用户可见改动总结。",
        trigger: {
          keywords: ["release notes", "changelog", "发布说明", "版本说明", "更新日志"],
          description: "当用户需要面向发布或用户说明变更时触发。"
        },
        capabilities: [
          { id: "group", label: "分类整理", description: "按功能、修复、文档、破坏性变化分组。" },
          { id: "user-facing", label: "用户视角", description: "把工程改动翻译成用户可理解说明。" },
          { id: "migration", label: "迁移提示", description: "指出需要用户采取的动作。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "发布说明要面向用户价值，而不是只列文件变化。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "docs-knowledge",
    name: "文档与知识组",
    description: "覆盖 README、API 文档、遗留代码解释、项目规则和知识沉淀。",
    category: "docs",
    skills: [
      {
        id: "readme-builder",
        name: "README 生成与更新",
        category: "docs",
        summary: "生成项目介绍、快速开始、配置和路线图。",
        description: "适合把产品定位、安装使用和架构说明沉淀到 README。",
        trigger: {
          keywords: ["README", "项目介绍", "快速开始", "使用说明"],
          description: "当用户要求完善项目说明时触发。"
        },
        capabilities: [
          { id: "intro", label: "介绍", description: "说明项目定位。" },
          { id: "quickstart", label: "快速开始", description: "整理启动和配置步骤。" },
          { id: "roadmap", label: "路线图", description: "说明后续方向。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "medium",
        systemHint: "README 要突出 Rcode 对标主流 coding agent 的定位。",
        enabledByDefault: true
      },
      {
        id: "api-doc-writer",
        name: "API 文档生成",
        category: "docs",
        summary: "为后端接口、配置项和数据结构生成文档。",
        description: "适合 /api/models、/api/providers、/api/skills 等接口说明。",
        trigger: {
          keywords: ["API 文档", "接口文档", "参数", "响应", "endpoint"],
          description: "当用户要文档化接口和数据契约时触发。"
        },
        capabilities: [
          { id: "contract", label: "契约说明", description: "描述请求、响应和错误。" },
          { id: "examples", label: "示例", description: "给出最小示例。" },
          { id: "compat", label: "兼容提示", description: "说明向后兼容注意事项。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "medium",
        systemHint: "API 文档要以稳定数据契约为中心。",
        enabledByDefault: true
      },
      {
        id: "legacy-code-explainer",
        name: "遗留代码解释",
        category: "docs",
        summary: "解释旧代码、复杂逻辑和模块职责。",
        description: "适合接手陌生项目、迁移前梳理和团队知识传递。",
        trigger: {
          keywords: ["解释代码", "遗留代码", "复杂逻辑", "看不懂", "模块职责"],
          description: "当用户要求理解已有代码时触发。"
        },
        capabilities: [
          { id: "flow", label: "流程解释", description: "说明数据和调用流程。" },
          { id: "responsibility", label: "职责说明", description: "说明模块边界。" },
          { id: "risk", label: "风险提示", description: "指出易错点。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "解释遗留代码时用结构化方式讲清入口、流程、依赖和风险。",
        enabledByDefault: true
      },
      {
        id: "project-rules-writer",
        name: "项目规则生成",
        category: "docs",
        summary: "生成项目级 agent 规则、编码规范和 review checklist。",
        description: "适合沉淀 AGENTS.md、项目约束、架构决策和团队规范。",
        trigger: {
          keywords: ["规则", "AGENTS", "规范", "checklist", "项目约束"],
          description: "当用户希望 agent 记住项目标准时触发。"
        },
        capabilities: [
          { id: "standards", label: "编码标准", description: "整理命名、结构和风格要求。" },
          { id: "commands", label: "常用命令", description: "记录构建、测试和检查方式。" },
          { id: "review", label: "审查清单", description: "沉淀 reviewer 关注点。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "medium",
        systemHint: "项目规则要简洁、可执行，并服务后续 agent 会话。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "tools-integrations",
    name: "工具与集成组",
    description: "覆盖模型 provider、MCP、外部系统、设置页和工具市场。",
    category: "workflow",
    skills: [
      {
        id: "provider-onboarding",
        name: "Provider 接入向导",
        category: "provider",
        summary: "引导用户接入默认模型或自定义模型服务。",
        description: "适合设置页、模型市场、OpenAI-compatible、OpenRouter 和自定义服务。",
        trigger: {
          keywords: ["provider", "模型接入", "OpenRouter", "OpenAI-compatible", "Base URL", "MiMo"],
          description: "当用户配置模型或模型协议时触发。"
        },
        capabilities: [
          { id: "choose", label: "选择预设", description: "根据用户需求推荐 provider 类型。" },
          { id: "fields", label: "字段解释", description: "解释服务地址、模型名和能力声明。" },
          { id: "verify", label: "接入验证", description: "说明如何验证模型可用。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "medium",
        systemHint: "强调 MiMo 是默认通用免费入口，同时保留用户自定义模型自由。",
        enabledByDefault: true
      },
      {
        id: "mcp-connector-planner",
        name: "MCP 连接规划",
        category: "workflow",
        summary: "规划 MCP 或插件式工具接入。",
        description: "适合浏览器、Figma、GitHub、Slack、Jira、数据库、文档源等外部工具集成。",
        trigger: {
          keywords: ["MCP", "插件", "工具", "连接", "Figma", "GitHub", "Slack", "Jira"],
          description: "当用户希望连接外部工具或数据源时触发。"
        },
        capabilities: [
          { id: "source", label: "数据源识别", description: "识别要接入的外部系统。" },
          { id: "capability", label: "能力映射", description: "把外部能力映射到 Rcode tools。" },
          { id: "permission", label: "权限边界", description: "定义最小权限和审批策略。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "medium",
        systemHint: "规划外部工具接入时先定义能力边界和权限策略。",
        enabledByDefault: true
      },
      {
        id: "settings-ux-designer",
        name: "设置页体验设计",
        category: "workflow",
        summary: "规划模型、权限、工具和 skill 的设置页结构。",
        description: "适合把 Rcode 从工程原型推进成可配置产品。",
        trigger: {
          keywords: ["设置页", "settings", "模型设置", "权限设置", "skill 设置"],
          description: "当用户要求做设置入口或配置体验时触发。"
        },
        capabilities: [
          { id: "ia", label: "信息架构", description: "规划设置页分组。" },
          { id: "defaults", label: "默认值", description: "设计开箱默认配置。" },
          { id: "copy", label: "文案", description: "解释模型、权限和 skill。" }
        ],
        requiredTools: ["read_file", "write_file"],
        riskLevel: "medium",
        systemHint: "设置页要突出 Rcode 主流 agent 定位，并降低模型接入门槛。",
        enabledByDefault: true
      }
    ]
  },
  {
    id: "maintenance-and-operations",
    name: "维护与自动化组",
    description: "覆盖重复任务、批量修复、日志分析、发布和项目健康检查。",
    category: "workflow",
    skills: [
      {
        id: "lint-fix-assistant",
        name: "Lint 批量修复",
        category: "test",
        summary: "分析 lint 规则失败并规划批量修复。",
        description: "适合格式、未使用变量、类型风格和简单质量规则。",
        trigger: {
          keywords: ["lint", "eslint", "格式", "批量修复", "规范失败"],
          description: "当用户处理 lint 或格式问题时触发。"
        },
        capabilities: [
          { id: "classify", label: "规则分类", description: "区分可自动修复和需人工判断。" },
          { id: "batch", label: "批量策略", description: "规划安全的批量修复顺序。" },
          { id: "verify", label: "验证", description: "建议修复后的检查方式。" }
        ],
        requiredTools: ["read_file", "write_file", "run_shell"],
        riskLevel: "high",
        systemHint: "批量修复要保守，优先处理机械性问题。",
        enabledByDefault: true
      },
      {
        id: "log-analyzer",
        name: "日志分析",
        category: "workflow",
        summary: "从日志或工具输出中提取异常、模式和下一步。",
        description: "适合 server 输出、构建日志、测试日志和 agent 工具执行结果。",
        trigger: {
          keywords: ["日志", "log", "输出", "异常模式", "分析一下"],
          description: "当用户贴出长日志或命令输出时触发。"
        },
        capabilities: [
          { id: "extract", label: "关键提取", description: "从长日志中提取关键错误。" },
          { id: "pattern", label: "模式识别", description: "识别重复异常和上下文。" },
          { id: "next", label: "下一步", description: "给出排查顺序。" }
        ],
        requiredTools: [],
        riskLevel: "low",
        systemHint: "日志分析先摘要事实，再给出排查路径。",
        enabledByDefault: true
      },
      {
        id: "repo-health-check",
        name: "项目健康检查",
        category: "workflow",
        summary: "检查文档、配置、依赖、测试、构建和产品定位一致性。",
        description: "适合阶段性 review，确保 Rcode 持续朝主流 agent 产品方向推进。",
        trigger: {
          keywords: ["健康检查", "项目检查", "全局检查", "现状", "下一步"],
          description: "当用户要求评估项目整体状态时触发。"
        },
        capabilities: [
          { id: "docs", label: "文档检查", description: "检查定位和路线图一致性。" },
          { id: "code", label: "代码检查", description: "检查架构和模块化程度。" },
          { id: "roadmap", label: "路线建议", description: "给出下一阶段优先级。" }
        ],
        requiredTools: ["read_file"],
        riskLevel: "medium",
        systemHint: "健康检查要输出当前状态、缺口和下一步优先级。",
        enabledByDefault: true
      }
    ]
  }
];

export const mainstreamSkills: AgentSkill[] = mainstreamSkillPackGroups.flatMap((group) => group.skills);

export function listMainstreamSkillGroups() {
  return mainstreamSkillPackGroups;
}

export function listMainstreamSkillsByGroup(groupId: string) {
  return mainstreamSkillPackGroups.find((group) => group.id === groupId)?.skills ?? [];
}

export function listMainstreamSkillsByCategory(category: SkillCategory) {
  return mainstreamSkills.filter((skill) => skill.category === category);
}
