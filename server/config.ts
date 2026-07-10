import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentToolName, LegacyPermissionMode, PermissionMode, ToolRisk } from "./types";
import { getActiveAiProviderId, listUserAiProviders } from "./localDatabase";

export interface ProviderEntry {
  type: "openai-compatible";
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv: string;
  chatCompletionsPath?: string;
  modelsPath?: string;
  defaultModel: string;
  fallbackModels?: string[];
  enabled?: boolean;
  source?: "builtin" | "user";
}

interface ProvidersConfig {
  activeProvider: string;
  providers: Record<string, ProviderEntry>;
}

interface ToolConfig {
  name: AgentToolName;
  risk: ToolRisk;
  enabled: boolean;
}

interface AgentTomlConfig {
  ai?: {
    provider_config?: string;
    active_provider?: string;
    temperature?: number;
    max_tokens?: number;
  };
  permissions?: {
    default_mode?: PermissionMode | LegacyPermissionMode;
    require_approval_for_internet?: boolean;
    require_approval_for_file_write?: boolean;
    require_approval_for_shell?: boolean;
  };
  computer_control?: {
    enabled?: boolean;
    shell?: boolean;
    dangerous_commands_require_approval?: boolean;
    command_policy?: {
      workspace_only?: boolean;
      blocked?: string[];
    };
  };
  tools?: ToolConfig[];
}

export interface RuntimeConfig {
  provider: ProviderEntry;
  providerName: string;
  providers: Record<string, ProviderEntry>;
  temperature: number;
  maxTokens: number;
  defaultPermissionMode: PermissionMode;
  permissions: {
    requireApprovalForInternet: boolean;
    requireApprovalForFileWrite: boolean;
    requireApprovalForShell: boolean;
  };
  tools: Map<AgentToolName, ToolConfig>;
  computerControl: {
    enabled: boolean;
    shell: boolean;
    dangerousCommandsRequireApproval: boolean;
    blockedCommands: string[];
  };
}

const workspaceRoot = process.cwd();

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readToml<T>(filePath: string): T {
  return parseToml(readFileSync(filePath, "utf8")) as T;
}

function resolveWorkspacePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
}

function buildRuntimeConfig(): RuntimeConfig {
  const agentConfigPath = resolveWorkspacePath(process.env.AGENT_CONFIG_PATH ?? "config/agent.toml");
  const agentConfig = readToml<AgentTomlConfig>(agentConfigPath);
  const providersPath = resolveWorkspacePath(agentConfig.ai?.provider_config ?? "config/providers.json");
  const providersConfig = readJson<ProvidersConfig>(providersPath);
  const builtinProviders = Object.fromEntries(
    Object.entries(providersConfig.providers).map(([id, provider]) => [id, { ...provider, source: "builtin" as const }])
  );
  const userProviders = Object.fromEntries(
    listUserAiProviders()
      .filter((provider) => provider.enabled !== false)
      .map((provider) => [
        provider.id,
        {
          type: provider.type,
          displayName: provider.displayName,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiKeyEnv: provider.apiKeyEnv || "AI_API_KEY",
          chatCompletionsPath: provider.chatCompletionsPath,
          modelsPath: provider.modelsPath,
          defaultModel: provider.defaultModel,
          fallbackModels: provider.fallbackModels,
          enabled: provider.enabled,
          source: "user" as const
        }
      ])
  );
  const providers = { ...builtinProviders, ...userProviders };
  const activeProvider =
    process.env.AI_PROVIDER ??
    getActiveAiProviderId() ??
    agentConfig.ai?.active_provider ??
    providersConfig.activeProvider;
  const provider = providers[activeProvider] ?? providers[providersConfig.activeProvider];
  const defaultMode = agentConfig.permissions?.default_mode === "request_approval" || agentConfig.permissions?.default_mode === "auto_approve"
    ? "workspace_write"
    : agentConfig.permissions?.default_mode;

  if (!provider) {
    const defaultProvider: ProviderEntry = {
      type: "openai-compatible",
      displayName: "未配置",
      baseUrl: "",
      apiKeyEnv: "AI_API_KEY",
      defaultModel: "",
      source: "builtin"
    };
    return {
      provider: defaultProvider,
      providerName: activeProvider || "none",
      providers,
      temperature: agentConfig.ai?.temperature ?? 0.3,
      maxTokens: agentConfig.ai?.max_tokens ?? 2048,
      defaultPermissionMode: defaultMode ?? "workspace_write",
      permissions: {
        requireApprovalForInternet: agentConfig.permissions?.require_approval_for_internet ?? true,
        requireApprovalForFileWrite: agentConfig.permissions?.require_approval_for_file_write ?? true,
        requireApprovalForShell: agentConfig.permissions?.require_approval_for_shell ?? true
      },
      tools: new Map((agentConfig.tools ?? []).map((tool) => [tool.name, tool])),
      computerControl: {
        enabled: agentConfig.computer_control?.enabled ?? false,
        shell: agentConfig.computer_control?.shell ?? false,
        dangerousCommandsRequireApproval:
          agentConfig.computer_control?.dangerous_commands_require_approval ?? true,
        blockedCommands: agentConfig.computer_control?.command_policy?.blocked ?? []
      }
    };
  }

  return {
    provider,
    providerName: providers[activeProvider] ? activeProvider : providersConfig.activeProvider,
    providers,
    temperature: agentConfig.ai?.temperature ?? 0.3,
    maxTokens: agentConfig.ai?.max_tokens ?? 2048,
    defaultPermissionMode: defaultMode ?? "workspace_write",
    permissions: {
      requireApprovalForInternet: agentConfig.permissions?.require_approval_for_internet ?? true,
      requireApprovalForFileWrite: agentConfig.permissions?.require_approval_for_file_write ?? true,
      requireApprovalForShell: agentConfig.permissions?.require_approval_for_shell ?? true
    },
    tools: new Map((agentConfig.tools ?? []).map((tool) => [tool.name, tool])),
    computerControl: {
      enabled: agentConfig.computer_control?.enabled ?? false,
      shell: agentConfig.computer_control?.shell ?? false,
      dangerousCommandsRequireApproval:
        agentConfig.computer_control?.dangerous_commands_require_approval ?? true,
      blockedCommands: agentConfig.computer_control?.command_policy?.blocked ?? []
    }
  };
}

let cachedConfig: RuntimeConfig | undefined;

export function getRuntimeConfig(): RuntimeConfig {
  cachedConfig ??= buildRuntimeConfig();
  return cachedConfig;
}

export function reloadRuntimeConfig(): RuntimeConfig {
  cachedConfig = undefined;
  return getRuntimeConfig();
}
