import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentToolName, PermissionMode, ToolRisk } from "./types";

interface ProviderEntry {
  type: "openai-compatible";
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  chatCompletionsPath?: string;
  modelsPath?: string;
  defaultModel: string;
  fallbackModels?: string[];
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
    default_mode?: PermissionMode;
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
  const activeProvider = agentConfig.ai?.active_provider ?? providersConfig.activeProvider;
  const provider = providersConfig.providers[activeProvider];

  if (!provider) {
    throw new Error(`AI provider "${activeProvider}" was not found in ${providersPath}`);
  }

  return {
    provider,
    providerName: activeProvider,
    temperature: agentConfig.ai?.temperature ?? 0.3,
    maxTokens: agentConfig.ai?.max_tokens ?? 2048,
    defaultPermissionMode: agentConfig.permissions?.default_mode ?? "request_approval",
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
