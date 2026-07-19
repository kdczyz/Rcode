import { randomUUID } from "node:crypto";
import type { AiProviderConfig } from "../storage/database";
import {
  deleteUserAiProvider,
  getUserAiProvider,
  listUserAiProviders,
  saveUserAiProvider,
  setActiveAiProviderId
} from "../storage/database";
import { getRuntimeConfig, reloadRuntimeConfig, type ProviderEntry } from "../runtime/config";

export interface PublicAiProvider extends Omit<AiProviderConfig, "apiKey"> {
  active: boolean;
  configured: boolean;
  apiKeyPreview?: string;
}

export interface ProviderBalanceAmount {
  currency: string;
  amount: number;
  grantedAmount?: number;
  toppedUpAmount?: number;
}

export type ProviderBalanceResult =
  | { status: "available"; source: string; balances: ProviderBalanceAmount[]; endpoint: string; checkedAt: string }
  | { status: "unlimited"; source: string; endpoint: string; checkedAt: string }
  | { status: "unsupported"; source: string; reason: string; checkedAt: string }
  | { status: "unavailable"; source: string; error: string; endpoint?: string; checkedAt: string };

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

const imageModelPattern = /(?:^|[-_.\/])(gpt-image|dall-e|image|imagen|flux|sdxl|stable-diffusion|recraft|seedream)(?:$|[-_.\/\d])/i;

export function inferImageModels(models: Array<string | undefined>) {
  return [...new Set(models
    .map((model) => model?.trim())
    .filter((model): model is string => Boolean(model) && imageModelPattern.test(model!)))];
}

function withInferredImageModels(provider: AiProviderConfig): AiProviderConfig {
  const imageModels = [...new Set([
    provider.defaultImageModel,
    ...(provider.imageModels ?? []),
    ...inferImageModels([provider.defaultModel, ...(provider.fallbackModels ?? [])])
  ].filter((model): model is string => Boolean(model)))].slice(0, 40);
  return {
    ...provider,
    defaultImageModel: provider.defaultImageModel || imageModels[0],
    imageModels
  };
}

function previewSecret(value: string | undefined) {
  if (!value) return undefined;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function resolveProviderApiKey(provider: Pick<AiProviderConfig, "apiKey" | "apiKeyEnv">) {
  return provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : process.env.AI_API_KEY);
}

function providerEntryToConfig(id: string, provider: ProviderEntry, source: "builtin" | "user"): AiProviderConfig {
  return withInferredImageModels({
    id,
    displayName: provider.displayName,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyEnv: provider.apiKeyEnv,
    chatCompletionsPath: provider.chatCompletionsPath,
    imageGenerationPath: provider.imageGenerationPath,
    modelsPath: provider.modelsPath,
    balancePath: provider.balancePath,
    defaultModel: provider.defaultModel,
    fallbackModels: provider.fallbackModels,
    defaultImageModel: provider.defaultImageModel,
    imageModels: provider.imageModels,
    reasoningDialect: provider.reasoningDialect,
    enabled: provider.enabled !== false,
    source
  });
}

export function toPublicAiProvider(provider: AiProviderConfig, activeProviderId: string): PublicAiProvider {
  const normalized = withInferredImageModels(provider);
  const configured = Boolean(resolveProviderApiKey(normalized));
  const { apiKey: _apiKey, ...rest } = normalized;
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

export interface WorkAiSyncCandidate {
  providerId: string;
  displayName: string;
  baseUrl: string;
  chatCompletionsPath: string;
  model: string;
  models: string[];
  imageGenerationPath: string;
  defaultImageModel?: string;
  imageModels: string[];
  apiKey: string;
}

export async function getWorkAiSyncCandidate(providerId?: string): Promise<WorkAiSyncCandidate> {
  const selectedId = providerId?.trim() || getRuntimeConfig().providerName;
  if (!selectedId) throw new Error("请先选择一个 AI 接口");
  const provider = resolveProviderForTest(selectedId);
  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) throw new Error(`AI 接口“${provider.displayName}”尚未配置 API Key`);
  const discovered = await fetchModelsForConfig(provider);
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    chatCompletionsPath: provider.chatCompletionsPath || "/chat/completions",
    model: provider.defaultModel,
    models: [...new Set([
      provider.defaultModel,
      ...(provider.fallbackModels ?? []),
      ...discovered.models.map((model) => model.id)
    ].filter(Boolean))].slice(0, 80),
    imageGenerationPath: provider.imageGenerationPath || "/images/generations",
    defaultImageModel: provider.defaultImageModel,
    imageModels: [...new Set([provider.defaultImageModel, ...(provider.imageModels ?? [])].filter((model): model is string => Boolean(model)))].slice(0, 40),
    apiKey
  };
}

export async function getWorkAiSyncCandidates(): Promise<WorkAiSyncCandidate[]> {
  const configured = listAiProviders().providers.filter((provider) => provider.configured && provider.enabled !== false);
  return Promise.all(configured.map((provider) => getWorkAiSyncCandidate(provider.id)));
}

export function normalizeAiProviderInput(input: Partial<AiProviderConfig>) {
  const id = typeof input.id === "string" && input.id.trim()
    ? input.id.trim().replace(/[^a-zA-Z0-9_-]/g, "-")
    : `ai_${randomUUID()}`;
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
  const defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : "";
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!defaultModel) throw new Error("defaultModel is required");
  const fallbackModels = Array.isArray(input.fallbackModels) ? input.fallbackModels.map(String).filter(Boolean) : [];
  const configuredImageModels = Array.isArray(input.imageModels) ? input.imageModels.map(String).map((model) => model.trim()).filter(Boolean) : [];
  const inferredImageModels = inferImageModels([defaultModel, ...fallbackModels]);
  const imageModels = [...new Set([...configuredImageModels, ...inferredImageModels])];
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
    imageGenerationPath: typeof input.imageGenerationPath === "string" && input.imageGenerationPath.trim()
      ? input.imageGenerationPath.trim()
      : "/images/generations",
    modelsPath: typeof input.modelsPath === "string" && input.modelsPath.trim() ? input.modelsPath.trim() : "/models",
    balancePath: typeof input.balancePath === "string" && input.balancePath.trim() ? input.balancePath.trim() : undefined,
    defaultModel,
    fallbackModels,
    defaultImageModel: typeof input.defaultImageModel === "string" && input.defaultImageModel.trim() ? input.defaultImageModel.trim() : imageModels[0],
    imageModels,
    reasoningDialect: (input.reasoningDialect === "sub2api" || input.reasoningDialect === "openai-compatible"
      ? input.reasoningDialect
      : "auto") as AiProviderConfig["reasoningDialect"],
    enabled: input.enabled !== false,
    source: "user" as const
  };
}

export function saveAiProvider(input: Partial<AiProviderConfig>) {
  const normalized = normalizeAiProviderInput(input);
  const existing = getUserAiProvider(normalized.id);
  const provider = saveUserAiProvider({
    ...normalized,
    apiKey: normalized.apiKey ?? existing?.apiKey
  });
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
  if (userProvider) return withInferredImageModels(userProvider);
  throw new Error(`AI provider "${id}" was not found`);
}

/** Resolves a configured provider for an Agent request without changing the desktop-wide active provider. */
export function resolveAiProviderForExecution(id: string): AiProviderConfig {
  const provider = resolveProviderForTest(id);
  return { ...provider, apiKey: resolveProviderApiKey(provider) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function readCurrency(record: Record<string, unknown>) {
  const value = record.currency ?? record.currency_code ?? record.unit;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "USD";
}

export function normalizeProviderBalanceResponse(payload: unknown):
  | { status: "available"; balances: ProviderBalanceAmount[] }
  | { status: "unlimited" }
  | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const data = asRecord(root.data) ?? root;
  const balanceInfos = Array.isArray(root.balance_infos)
    ? root.balance_infos
    : Array.isArray(data.balance_infos)
      ? data.balance_infos
      : undefined;
  if (balanceInfos) {
    const balances = balanceInfos.flatMap((item) => {
      const record = asRecord(item);
      const amount = record ? asFiniteNumber(record.total_balance ?? record.available_balance ?? record.balance) : undefined;
      if (!record || amount === undefined) return [];
      return [{
        currency: readCurrency(record),
        amount,
        grantedAmount: asFiniteNumber(record.granted_balance),
        toppedUpAmount: asFiniteNumber(record.topped_up_balance)
      }];
    });
    if (balances.length > 0) return { status: "available", balances };
  }

  if (("limit_remaining" in data && data.limit_remaining === null) || ("remaining" in data && data.remaining === null)) {
    return { status: "unlimited" };
  }

  const limitRemaining = asFiniteNumber(data.limit_remaining);
  if (limitRemaining !== undefined) {
    return { status: "available", balances: [{ currency: readCurrency(data), amount: limitRemaining }] };
  }

  const totalCredits = asFiniteNumber(data.total_credits);
  const totalUsage = asFiniteNumber(data.total_usage);
  if (totalCredits !== undefined && totalUsage !== undefined) {
    return { status: "available", balances: [{ currency: readCurrency(data), amount: Math.max(0, totalCredits - totalUsage) }] };
  }

  const amount = asFiniteNumber(
    data.total_balance ??
    data.available_balance ??
    data.remaining_balance ??
    data.credit_balance ??
    data.balance ??
    data.remaining ??
    data.credits
  );
  if (amount === undefined) return undefined;
  return { status: "available", balances: [{ currency: readCurrency(data), amount }] };
}

function inferProviderBalanceUrl(provider: AiProviderConfig) {
  const explicitPath = provider.balancePath?.trim();
  if (explicitPath) {
    return {
      url: /^https?:\/\//i.test(explicitPath)
        ? explicitPath
        : `${provider.baseUrl.replace(/\/+$/, "")}/${explicitPath.replace(/^\/+/, "")}`,
      inferred: false
    };
  }
  let base: URL;
  try {
    base = new URL(provider.baseUrl);
  } catch {
    return undefined;
  }
  if (base.hostname === "api.deepseek.com" || base.hostname.endsWith(".deepseek.com")) {
    return { url: `${base.origin}/user/balance`, inferred: true };
  }
  if (base.hostname === "openrouter.ai" || base.hostname.endsWith(".openrouter.ai")) {
    return { url: `${base.origin}/api/v1/key`, inferred: true };
  }
  return undefined;
}

export async function fetchProviderBalance(id: string): Promise<ProviderBalanceResult> {
  const provider = resolveProviderForTest(id);
  const checkedAt = new Date().toISOString();
  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    return { status: "unavailable", source: provider.id, error: "未配置 API Key", checkedAt };
  }
  const request = inferProviderBalanceUrl(provider);
  if (!request) {
    return {
      status: "unsupported",
      source: provider.id,
      reason: "该上游未公开余额接口，可在高级设置中配置余额路径",
      checkedAt
    };
  }
  try {
    const response = await fetch(request.url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "Rcode"
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      if (request.inferred && (response.status === 404 || response.status === 405)) {
        return { status: "unsupported", source: provider.id, reason: "上游未开放余额查询", checkedAt };
      }
      return {
        status: "unavailable",
        source: provider.id,
        error: `上游余额接口返回 HTTP ${response.status}`,
        endpoint: request.url,
        checkedAt
      };
    }
    const parsed = normalizeProviderBalanceResponse(await response.json());
    if (!parsed) {
      return {
        status: "unavailable",
        source: provider.id,
        error: "无法识别上游余额响应",
        endpoint: request.url,
        checkedAt
      };
    }
    return { ...parsed, source: provider.id, endpoint: request.url, checkedAt };
  } catch (error) {
    return {
      status: "unavailable",
      source: provider.id,
      error: error instanceof Error ? error.message : "上游余额查询失败",
      endpoint: request.url,
      checkedAt
    };
  }
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
    balancePath: typeof input.balancePath === "string" && input.balancePath.trim() ? input.balancePath.trim() : undefined,
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
