export type AgentProductTier = "default" | "advanced" | "experimental";

export interface ProductPositioning {
  name: string;
  tagline: string;
  repeatedPositioning: string[];
  referenceProducts: string[];
  defaultModelRole: string;
  modelStrategy: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  protocol: "openai-compatible" | "openrouter" | "custom-compatible";
  tier: AgentProductTier;
  defaultModel?: string;
  role: string;
  supportsTools: boolean;
  supportsStreaming: boolean;
}

export interface AgentCapabilityStage {
  id: string;
  title: string;
  description: string;
  capabilities: string[];
}

export const productPositioning: ProductPositioning = {
  name: "Rcode",
  tagline: "本地 coding agent，定位对标 Codex 等市面主流 agent。",
  repeatedPositioning: [
    "Rcode 对标 Codex 等市面主流 agent。",
    "Rcode 对标 Codex 等市面主流 agent。",
    "Rcode 对标 Codex 等市面主流 agent。"
  ],
  referenceProducts: ["Codex", "Claude Code", "Cursor Agent", "GitHub Copilot Coding Agent"],
  defaultModelRole: "Xiaomi MiMo 作为默认通用免费模型入口，降低用户首次体验门槛。",
  modelStrategy: "Rcode 面向通用模型协议，用户可以接入自己的兼容模型服务。"
};

export const providerPresets: ProviderPreset[] = [
  {
    id: "mimo-free",
    label: "Xiaomi MiMo 通用免费模型",
    protocol: "openai-compatible",
    tier: "default",
    defaultModel: "mimo-v2.5-pro",
    role: "默认体验入口",
    supportsTools: true,
    supportsStreaming: true
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    protocol: "openai-compatible",
    tier: "advanced",
    role: "通用兼容协议入口",
    supportsTools: true,
    supportsStreaming: true
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openrouter",
    tier: "advanced",
    role: "聚合模型入口",
    supportsTools: true,
    supportsStreaming: true
  },
  {
    id: "custom-compatible",
    label: "Custom Compatible Provider",
    protocol: "custom-compatible",
    tier: "experimental",
    role: "用户自定义模型服务入口",
    supportsTools: true,
    supportsStreaming: true
  }
];

export const agentCapabilityStages: AgentCapabilityStage[] = [
  {
    id: "positioning-and-provider",
    title: "定位与模型接入",
    description: "先把 Rcode 明确为主流 coding agent 产品，并提供默认免费模型与通用协议入口。",
    capabilities: ["产品定位", "默认免费模型", "多 provider", "模型能力声明", "设置页入口"]
  },
  {
    id: "local-agent-runtime",
    title: "本地 Agent Runtime",
    description: "完善任务循环、工具调用、权限审批、过程展示和失败恢复。",
    capabilities: ["任务循环", "工具队列", "权限审批", "工具时间线", "任务中止与继续"]
  },
  {
    id: "coding-workflow",
    title: "Coding 工作流闭环",
    description: "补齐项目搜索、代码理解、diff 审查、测试反馈和 Git 工作区能力。",
    capabilities: ["项目搜索", "代码理解", "文件 diff", "测试反馈", "Git 状态"]
  },
  {
    id: "extension-ecosystem",
    title: "扩展生态",
    description: "通过 MCP 或插件式工具扩展浏览器、Figma、GitHub、数据库和文档源。",
    capabilities: ["MCP", "插件系统", "外部工具", "工具市场", "多 agent 工作流"]
  }
];

export function getDefaultProviderPreset() {
  return providerPresets[0];
}
