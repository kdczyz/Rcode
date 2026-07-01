import { toolDefinitions } from "./tools";
import type { AgentMessage, ToolCall, ToolResult } from "./types";
import { getRuntimeConfig } from "./config";

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

export interface AiTurn {
  content: string;
  toolCalls: ToolCall[];
}

export type ThinkingMode = "fast" | "balanced" | "deep";

const baseSystemPrompt = [
  "You are a local agent runtime inside a Chinese agent software prototype.",
  "Use tools only when needed. Explain your next action clearly.",
  "When file or internet access is needed, call one of the provided tools.",
  "Keep final answers concise and practical."
].join("\n");

function getThinkingInstruction(mode: ThinkingMode = "balanced") {
  if (mode === "fast") {
    return "Thinking mode: fast. Prefer direct answers and minimal exploration.";
  }

  if (mode === "deep") {
    return "Thinking mode: deep. Think through tradeoffs carefully before answering, while keeping the final answer readable.";
  }

  return "Thinking mode: balanced. Use enough reasoning to be reliable without over-explaining.";
}

function getConfig(modelOverride?: string) {
  const runtimeConfig = getRuntimeConfig();
  return {
    apiKey: process.env.AI_API_KEY ?? process.env[runtimeConfig.provider.apiKeyEnv],
    baseUrl: process.env.AI_BASE_URL ?? runtimeConfig.provider.baseUrl,
    chatPath: runtimeConfig.provider.chatCompletionsPath ?? "/chat/completions",
    model: modelOverride || process.env.AI_MODEL || runtimeConfig.provider.defaultModel,
    temperature: runtimeConfig.temperature,
    maxTokens: runtimeConfig.maxTokens
  };
}

function toProviderMessages(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  thinkingMode?: ThinkingMode,
  projectPath?: string
) {
  const projectInstruction = projectPath
    ? `Current project root: ${projectPath}. Resolve relative file paths and shell commands inside this project unless the user asks otherwise.`
    : "Current project type: empty project. Use relative file paths from the app workspace unless the user provides a folder path.";
  const providerMessages: Array<Record<string, unknown>> = [
    { role: "system", content: `${baseSystemPrompt}\n${getThinkingInstruction(thinkingMode)}\n${projectInstruction}` },
    ...messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content
        };
      }

      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments)
            }
          }))
        };
      }

      return {
        role: message.role,
        content: message.content
      };
    })
  ];

  for (const result of toolResults) {
    providerMessages.push({
      role: "tool",
      tool_call_id: result.toolCallId,
      content: result.content
    });
  }

  return providerMessages;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function callAi(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; signal?: AbortSignal } = {}
): Promise<AiTurn> {
  const config = getConfig(options.model);

  if (!config.apiKey) {
    return {
      content:
        "AI_API_KEY 尚未配置。当前框架已就绪：配置 .env 后即可连接兼容 OpenAI Chat Completions 的模型，并按权限模式执行工具调用。",
      toolCalls: []
    };
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`, {
    method: "POST",
    signal: options.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: toProviderMessages(messages, toolResults, options.thinkingMode, options.projectPath),
      tools: toolDefinitions,
      tool_choice: "auto",
      temperature: config.temperature,
      max_tokens: config.maxTokens
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI provider error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as ChatResponse;
  const message = data.choices?.[0]?.message;
  const toolCalls =
    message?.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name as ToolCall["name"],
      arguments: parseToolArguments(toolCall.function.arguments)
    })) ?? [];

  return {
    content: message?.content ?? "",
    toolCalls
  };
}
