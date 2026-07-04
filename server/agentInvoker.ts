import { callAi, callAiStream, type ThinkingMode } from "./aiProvider";
import { prepareAgentContext, type AgentContextBudget } from "./agentContext";
import type { AgentMessage, ToolCall, ToolResult } from "./types";

export interface OptimizedAgentInvocationOptions {
  model?: string;
  thinkingMode?: ThinkingMode;
  projectPath?: string;
  signal?: AbortSignal;
  contextBudget?: Partial<AgentContextBudget>;
}

export interface OptimizedAgentStreamEvent {
  type: "text_delta" | "tool_calls";
  content?: string;
  toolCalls?: ToolCall[];
  cleanContent?: string;
}

function logContextStats(label: string, stats: ReturnType<typeof prepareAgentContext>["stats"]) {
  console.log(
    `[AgentContext] ${label}: intent=${stats.deliveryIntent}, messages ${stats.originalMessages}->${stats.finalMessages}, chars ${stats.originalChars}->${stats.finalChars}, skills=${stats.matchedSkills.join(",") || "none"}`
  );
}

export async function callAgentOptimized(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  options: OptimizedAgentInvocationOptions = {}
) {
  const prepared = prepareAgentContext(messages, {
    projectPath: options.projectPath,
    thinkingMode: options.thinkingMode,
    budget: options.contextBudget
  });

  logContextStats("non-stream", prepared.stats);

  return callAi(prepared.messages, toolResults, {
    model: options.model,
    thinkingMode: options.thinkingMode,
    projectPath: options.projectPath,
    signal: options.signal
  });
}

export async function* callAgentStreamOptimized(
  messages: AgentMessage[],
  options: OptimizedAgentInvocationOptions = {}
): AsyncGenerator<OptimizedAgentStreamEvent> {
  const prepared = prepareAgentContext(messages, {
    projectPath: options.projectPath,
    thinkingMode: options.thinkingMode,
    budget: options.contextBudget
  });

  logContextStats("stream", prepared.stats);

  for await (const event of callAiStream(prepared.messages, {
    model: options.model,
    thinkingMode: options.thinkingMode,
    projectPath: options.projectPath,
    signal: options.signal
  })) {
    yield event;
  }
}
