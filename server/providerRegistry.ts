export type ProviderProtocol = "openai-compatible" | "openrouter" | "custom-compatible";

export interface ProviderCapabilityProfile {
  chat: boolean;
  tools: boolean;
  streaming: boolean;
  embeddings: boolean;
}

export interface ProviderRegistryItem {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  defaultModel?: string;
  description: string;
  builtIn: boolean;
  defaultFreeModel: boolean;
  capabilities: ProviderCapabilityProfile;
}

export const builtInProviderRegistry: ProviderRegistryItem[] = [
  {
    id: "mimo",
    displayName: "Xiaomi MiMo 通用免费模型",
    protocol: "openai-compatible",
    defaultModel: "mimo-v2.5-pro",
    description: "Rcode 默认通用免费模型入口，用于降低首次体验门槛。",
    builtIn: true,
    defaultFreeModel: true,
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      embeddings: false
    }
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible",
    protocol: "openai-compatible",
    description: "通用兼容协议入口，适合接入兼容 Chat Completions 的模型服务。",
    builtIn: true,
    defaultFreeModel: false,
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      embeddings: false
    }
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    protocol: "openrouter",
    description: "聚合模型入口，适合接入多模型路由服务。",
    builtIn: true,
    defaultFreeModel: false,
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      embeddings: false
    }
  },
  {
    id: "custom-compatible",
    displayName: "Custom Compatible Provider",
    protocol: "custom-compatible",
    description: "用户自定义兼容模型服务入口。",
    builtIn: true,
    defaultFreeModel: false,
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      embeddings: false
    }
  }
];

export function getBuiltInProvider(id: string) {
  return builtInProviderRegistry.find((provider) => provider.id === id);
}

export function getDefaultFreeProvider() {
  return builtInProviderRegistry.find((provider) => provider.defaultFreeModel) ?? builtInProviderRegistry[0];
}

export function listProviderProtocols() {
  return [...new Set(builtInProviderRegistry.map((provider) => provider.protocol))];
}
