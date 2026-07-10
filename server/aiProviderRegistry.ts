import { randomUUID } from "node:crypto";
import type { AiProviderConfig } from "./localDatabase";
import {
  deleteUserAiProvider,
  getActiveAiProviderId,
  getUserAiProvider,
  listUserAiProviders,
  saveUserAiProvider,
  setActiveAiProviderId
} from "./localDatabase";
import { getRuntimeConfig, reloadRuntimeConfig, type ProviderEntry } from "./config";

export interface PublicAiProvider extends Omit<AiProviderConfig, "apiKey"> {
  active: boolean;
  configured: boolean;
  apiKeyPreview?: string;
}

const knownCompatSuffixes = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude"
];

function previewSecret(value: string | undefined) {
  if (!value) return undefined;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function resolveProviderApiKey(provider: Pick<AiProviderConfig, "apiKey" | "apiKeyEnv">) {
  return provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined) || process.env.AI_API_KEY;
}

function providerEntryToConfig(id: string, provider: ProviderEntry, source: "builtin" | "user"): AiProviderConfig {
  return {
    id,
    displayName: provider.displayName,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyEnv: provider.apiKeyEnv,
    chatCompletionsPath: provider.chatCompletionsPath,
    modelsPath: provider.modelsPath,
    defaultModel: provider.defaultModel,
    fallbackModels: provider.fallbackModels,
    enabled: provider.enabled !== false,
    source
  };
}

export function toPublicAiProvider(provider: AiProviderConfig, activeProviderId: string): PublicAiProvider {
  const configured = Boolean(resolveProviderApiKey(provider));
  const { apiKey: _apiKey, ...rest } = provider;
  return {
    ...rest,
    active: provider.id === activeProviderId,
    configured,
    apiKeyPreview: previewSecret(provider.apiKey)
  };
}

export function listAiProviders() {
  const runtimeConfig = getRuntimeConfig();
  const userProviders = listUserAiProviders();
  const merged = new Map<string, AiProviderConfig>();
  for (const [id, provider] of Object.entries(runtimeConfig.providers)) {
    merged.set(id, providerEntryToConfig(id, provider, provider.source ?? "builtin"));
  }
  for (const provider of userProviders) merged.set(provider.id, { ...provider, source: "user" });
  const activeProviderId = runtimeConfig.providerName;
  return {
    activeProviderId,
    providers: [...merged.values()].map((provider) => toPublicAiProvider(provider, activeProviderId))
  };
}

export function normalizeAiProviderInput(input: Partial<AiProviderConfig>) {
  const id = typeof input.id === "string" && input.id.trim()
    ? input.id.trim().replace(/[^a-zA-Z0-9_-]/g, "-")
    : `ai_${randomUUID()}`;
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
  const defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : "";
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!defaultModel) throw new Error("defaultModel is required");
  return {
    id,
    displayName: typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : id,
    type: "openai-compatible" as const,
    baseUrl,
    apiKey: typeof input.apiKey === "string" && input.apiKey ? input.apiKey.trim() : undefined,
    apiKeyEnv: typeof input.apiKeyEnv === "string" && input.apiKeyEnv.trim() ? input.apiKeyEnv.trim() : "AI_API_KEY",
    chatCompletionsPath: typeof input.chatCompletionsPath === "string" && input.chatCompletionsPath.trim()
      ? input.chatCompletionsPath.trim()
      : "/chat/completions",
    modelsPath: typeof input.modelsPath === "string" && input.modelsPath.trim() ? input.modelsPath.trim() : "/models",
    defaultModel,
    fallbackModels: Array.isArray(input.fallbackModels) ? input.fallbackModels.map(String).filter(Boolean) : [],
    enabled: input.enabled !== false,
    source: "user" as const
  };
}

export function saveAiProvider(input: Partial<AiProviderConfig>) {
  const provider = saveUserAiProvider(normalizeAiProviderInput(input));
  reloadRuntimeConfig();
  return provider;
}

export function activateAiProvider(id: string) {
  const catalog = listAiProviders();
  if (!catalog.providers.some((provider) => provider.id === id)) {
    throw new Error(`AI provider "${id}" was not found`);
  }
  setActiveAiProviderId(id);
  reloadRuntimeConfig();
}

export function removeAiProvider(id: string) {
  const existing = getUserAiProvider(id);
  if (!existing) throw new Error("Only user AI providers can be deleted");
  deleteUserAiProvider(id);
  reloadRuntimeConfig();
}

function endsWithVersionSegment(url: string) {
  const last = url.split("/").filter(Boolean).pop() ?? "";
  return /^v\d+$/.test(last);
}

function stripCompatSuffix(baseUrl: string) {
  return knownCompatSuffixes.find((suffix) => baseUrl.endsWith(suffix));
}

export function buildModelsUrlCandidates(baseUrl: string, modelsPath?: string) {
  const override = modelsPath?.trim();
  if (override && /^https?:\/\//i.test(override)) return [override];
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is empty");
  const candidates: string[] = [];
  if (override) {
    candidates.push(`${trimmed}/${override.replace(/^\/+/, "")}`);
  } else if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith("/v1")) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }
  const suffix = stripCompatSuffix(trimmed);
  if (suffix) {
    const root = trimmed.slice(0, -suffix.length).replace(/\/+$/, "");
    if (root) {
      candidates.push(`${root}/v1/models`);
      candidates.push(`${root}/models`);
    }
  }
  return candidates.filter((url, index) => candidates.indexOf(url) === index);
}

function resolveProviderForTest(id: string): AiProviderConfig {
  const runtime = getRuntimeConfig();
  const builtinProvider = runtime.providers[id];
  if (builtinProvider) {
    return providerEntryToConfig(id, builtinProvider, builtinProvider.source ?? "builtin");
  }
  const userProvider = getUserAiProvider(id);
  if (userProvider) return userProvider;
  throw new Error(`AI provider "${id}" was not found`);
}

async function fetchModelsForConfig(provider: AiProviderConfig) {
  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    return {
      source: provider.id,
      recommendedForAgent: [provider.defaultModel, ...(provider.fallbackModels ?? [])].filter(Boolean),
      models: []
    };
  }
  const candidates = buildModelsUrlCandidates(provider.baseUrl, provider.modelsPath);
  let lastError = "";
  for (const url of candidates) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "user-agent": "Rcode"
      },
      signal: AbortSignal.timeout(15000)
    }).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (!response) continue;
    const text = await response.text();
    if (!response.ok) {
      lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      if (response.status === 404 || response.status === 405) continue;
      break;
    }
    let parsed: { data?: Array<{ id: string; object?: string; owned_by?: string }> };
    try {
      parsed = JSON.parse(text) as { data?: Array<{ id: string; object?: string; owned_by?: string }> };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Failed to parse models response";
      continue;
    }
    const models = (parsed.data ?? []).filter((model) => model.id).sort((a, b) => a.id.localeCompare(b.id));
    const recommendedForAgent = [provider.defaultModel, ...(provider.fallbackModels ?? [])].filter(Boolean);
    return { source: provider.id, recommendedForAgent, models };
  }
  return {
    source: provider.id,
    recommendedForAgent: [provider.defaultModel, ...(provider.fallbackModels ?? [])].filter(Boolean),
    models: [],
    error: lastError
  };
}

export async function fetchProviderModels(id?: string) {
  const runtime = getRuntimeConfig();
  const provider = id ? resolveProviderForTest(id) : providerEntryToConfig(runtime.providerName, runtime.provider, runtime.provider.source ?? "builtin");
  return fetchModelsForConfig(provider);
}

export async function fetchModelsForDraft(input: Partial<AiProviderConfig>) {
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) throw new Error("baseUrl is required");
  const provider: AiProviderConfig = {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : "draft",
    displayName: typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : "Draft provider",
    type: "openai-compatible",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined,
    apiKeyEnv: typeof input.apiKeyEnv === "string" && input.apiKeyEnv.trim() ? input.apiKeyEnv.trim() : undefined,
    chatCompletionsPath: typeof input.chatCompletionsPath === "string" && input.chatCompletionsPath.trim() ? input.chatCompletionsPath.trim() : "/chat/completions",
    modelsPath: typeof input.modelsPath === "string" && input.modelsPath.trim() ? input.modelsPath.trim() : "/models",
    defaultModel: typeof input.defaultModel === "string" ? input.defaultModel.trim() : "",
    fallbackModels: [],
    enabled: true,
    source: "user"
  };
  return fetchModelsForConfig(provider);
}

export async function testAiProvider(id: string) {
  const provider = resolveProviderForTest(id);
  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    return {
      ok: false,
      source: provider.id,
      modelCount: 0,
      error: "API Key is required"
    };
  }
  const result = await fetchProviderModels(id);
  return {
    ok: !("error" in result),
    source: result.source,
    modelCount: result.models.length,
    error: "error" in result ? result.error : undefined
  };
}
