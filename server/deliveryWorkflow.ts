export type DeliveryIntent = "feature" | "bugfix" | "test" | "review" | "pr" | "general";

export interface DeliveryWorkflowProfile {
  intent: DeliveryIntent;
  title: string;
  summary: string;
  requiredBehaviors: string[];
  recommendedTools: string[];
  doneCriteria: string[];
}

const profiles: Record<DeliveryIntent, Omit<DeliveryWorkflowProfile, "intent">> = {
  feature: {
    title: "直接交付功能",
    summary: "优先把用户需求落成可运行代码，而不是停留在方案讨论。",
    requiredBehaviors: [
      "先快速定位相关文件和入口。",
      "必要时做短计划，但不要用长计划替代实现。",
      "完成代码改动后读取 git diff 并总结改动。",
      "能跑验证就跑 run_tests；不能跑要明确说明原因。"
    ],
    recommendedTools: ["read_file", "write_file", "git_diff", "run_tests"],
    doneCriteria: ["功能代码已修改", "关键路径已说明", "验证已运行或给出未运行原因", "下一步明确"]
  },
  bugfix: {
    title: "修 Bug",
    summary: "先定位根因，再做最小修复，最后验证。",
    requiredBehaviors: [
      "根据报错、复现、日志或用户描述追踪到相关代码。",
      "优先最小修复，不做无关重构。",
      "修复后运行最相关的测试、typecheck 或 build。",
      "解释根因、修复点和验证结果。"
    ],
    recommendedTools: ["read_file", "write_file", "run_tests", "git_diff"],
    doneCriteria: ["根因已说明", "修复已落地", "验证已运行或给出未运行原因", "无关改动已避免"]
  },
  test: {
    title: "跑测试与修 CI",
    summary: "把验证作为交付闭环的一部分，优先使用专用 run_tests 工具。",
    requiredBehaviors: [
      "先选择与改动最相关的验证命令。",
      "优先使用 run_tests 而不是普通 run_shell。",
      "如果失败，先总结关键错误，再修复。",
      "修复后再次验证。"
    ],
    recommendedTools: ["run_tests", "read_file", "write_file", "git_diff"],
    doneCriteria: ["验证命令已执行", "失败原因已归纳", "修复建议或修复结果明确"]
  },
  review: {
    title: "审查改动",
    summary: "像成熟 code review agent 一样优先指出高影响问题。",
    requiredBehaviors: [
      "先读取 git status 和 diff。",
      "按 correctness、test、security、maintainability 排序。",
      "只报告有证据的问题，避免泛泛建议。",
      "必要时给出可直接应用的修复。"
    ],
    recommendedTools: ["git_status", "git_diff", "read_file"],
    doneCriteria: ["高影响问题优先", "每个问题有位置和修复方向", "无发现也明确说明"]
  },
  pr: {
    title: "开 PR",
    summary: "准备 PR 前先确认分支、diff 和验证状态，然后生成 PR 描述并尝试打开 PR。",
    requiredBehaviors: [
      "先读取 git status 确认当前分支和改动。",
      "读取 git diff 总结文件级变化。",
      "确认或运行测试。",
      "生成包含 Summary、Tests、Risks 的 PR body。",
      "用户明确要求开 PR 时可调用 open_pull_request。"
    ],
    recommendedTools: ["git_status", "git_diff", "run_tests", "open_pull_request"],
    doneCriteria: ["PR 标题清晰", "PR body 包含 summary/tests/risks", "PR 已创建或失败原因明确"]
  },
  general: {
    title: "成熟 Coding Agent 默认模式",
    summary: "默认朝直接交付推进：理解任务、改代码、验证、总结。",
    requiredBehaviors: [
      "用户要功能就直接实现。",
      "用户要修 bug 就定位并修复。",
      "用户要验证就跑测试。",
      "用户要 PR 就准备并尝试打开 PR。",
      "不把长篇解释当成交付结果。"
    ],
    recommendedTools: ["read_file", "write_file", "git_status", "git_diff", "run_tests", "open_pull_request"],
    doneCriteria: ["有代码或明确验证结果", "说明做了什么", "说明测试状态", "说明剩余风险"]
  }
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export function detectDeliveryIntent(prompt: string): DeliveryIntent {
  const value = normalize(prompt);
  if (!value) return "general";

  if (["开 pr", "开PR", "pull request", "pr", "提交 pr", "发 pr"].some((keyword) => value.includes(normalize(keyword)))) {
    return "pr";
  }

  if (["修 bug", "bug", "报错", "异常", "修复", "不生效", "失败"].some((keyword) => value.includes(normalize(keyword)))) {
    return "bugfix";
  }

  if (["跑测试", "测试", "typecheck", "build", "ci", "lint", "构建"].some((keyword) => value.includes(normalize(keyword)))) {
    return "test";
  }

  if (["review", "审查", "检查代码", "看下改动", "diff"].some((keyword) => value.includes(normalize(keyword)))) {
    return "review";
  }

  if (["实现", "新增", "功能", "开发", "接入", "优化"].some((keyword) => value.includes(normalize(keyword)))) {
    return "feature";
  }

  return "general";
}

export function getDeliveryWorkflowProfile(prompt: string): DeliveryWorkflowProfile {
  const intent = detectDeliveryIntent(prompt);
  return { intent, ...profiles[intent] };
}

export function formatDeliveryWorkflowProfile(profile: DeliveryWorkflowProfile) {
  return [
    `Delivery intent: ${profile.intent} (${profile.title}).`,
    profile.summary,
    "Required behaviors:",
    ...profile.requiredBehaviors.map((item) => `- ${item}`),
    "Recommended tools:",
    `- ${profile.recommendedTools.join(", ")}`,
    "Done criteria:",
    ...profile.doneCriteria.map((item) => `- ${item}`)
  ].join("\n");
}
