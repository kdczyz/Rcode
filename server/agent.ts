import { nanoid } from "nanoid";
import { callAi, type ThinkingMode } from "./aiProvider";
import { getToolCallRisk, needsApproval } from "./permissions";
import { executeTool } from "./tools";
import type { AgentMessage, AgentRunResponse, PendingApproval, PermissionMode, ToolCall, ToolResult } from "./types";

interface Conversation {
  id: string;
  projectPath: string;
  messages: AgentMessage[];
  pendingApprovals: PendingApproval[];
}

/** 按项目路径隔离会话，同一个项目下的不同会话互不干扰。 */
const projectConversations = new Map<string, Map<string, Conversation>>();

function getProjectKey(projectPath?: string): string {
  return projectPath?.trim() || "__default__";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("operation was aborted"))
  );
}

function getConversation(conversationId?: string, projectPath?: string): Conversation {
  const projectKey = getProjectKey(projectPath);
  let projectMap = projectConversations.get(projectKey);
  if (!projectMap) {
    projectMap = new Map();
    projectConversations.set(projectKey, projectMap);
  }

  if (conversationId && projectMap.has(conversationId)) {
    return projectMap.get(conversationId)!;
  }

  const conversation: Conversation = {
    id: conversationId ?? nanoid(),
    projectPath: projectKey,
    messages: [],
    pendingApprovals: []
  };
  projectMap.set(conversation.id, conversation);
  return conversation;
}

function buildApproval(conversationId: string, toolCall: ToolCall, projectPath?: string): PendingApproval {
  return {
    id: nanoid(),
    conversationId,
    toolCall,
    risk: getToolCallRisk(toolCall),
    reason: `Agent 请求执行 ${toolCall.name}`,
    createdAt: new Date().toISOString(),
    projectPath
  };
}

async function resolveToolCalls(
  conversation: Conversation,
  mode: PermissionMode,
  toolCalls: ToolCall[],
  projectPath?: string
): Promise<{ pending: PendingApproval[]; results: ToolResult[] }> {
  const pending: PendingApproval[] = [];
  const results: ToolResult[] = [];

  for (const toolCall of toolCalls) {
    if (needsApproval(mode, toolCall, projectPath)) {
      const approval = buildApproval(conversation.id, toolCall, projectPath);
      pending.push(approval);
      conversation.pendingApprovals.push(approval);
    } else {
      results.push(await executeTool(toolCall, projectPath));
    }
  }

  return { pending, results };
}

async function continueConversation(
  conversation: Conversation,
  mode: PermissionMode,
  initialToolResults: ToolResult[] = [],
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; signal?: AbortSignal } = {}
): Promise<AgentRunResponse> {
  const allToolResults = [...initialToolResults];

  for (let step = 0; step < 5; step += 1) {
    const turn = await callAi(conversation.messages, [], options);
    conversation.messages.push({
      role: "assistant",
      content: turn.content,
      toolCalls: turn.toolCalls
    });

    if (turn.toolCalls.length === 0) {
      return {
        conversationId: conversation.id,
        status: "completed",
        answer: turn.content,
        toolResults: allToolResults
      };
    }

    const { pending, results } = await resolveToolCalls(conversation, mode, turn.toolCalls, options.projectPath);
    allToolResults.push(...results);

    for (const result of results) {
      conversation.messages.push({
        role: "tool",
        toolCallId: result.toolCallId,
        content: result.content
      });
    }

    if (pending.length > 0) {
      return {
        conversationId: conversation.id,
        status: "approval_required",
        answer: turn.content,
        pendingApprovals: pending,
        toolResults: allToolResults
      };
    }
  }

  return {
    conversationId: conversation.id,
    status: "error",
    error: "Agent stopped after too many tool-call turns.",
    toolResults: allToolResults
  };
}

export async function runAgent(input: {
  prompt: string;
  conversationId?: string;
  mode: PermissionMode;
  model?: string;
  thinkingMode?: ThinkingMode;
  projectPath?: string;
  signal?: AbortSignal;
}): Promise<AgentRunResponse> {
  const conversation = getConversation(input.conversationId, input.projectPath);
  conversation.messages.push({ role: "user", content: input.prompt });

  try {
    return await continueConversation(conversation, input.mode, [], {
      model: input.model,
      thinkingMode: input.thinkingMode,
      projectPath: input.projectPath,
      signal: input.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    return {
      conversationId: conversation.id,
      status: "error",
      error: error instanceof Error ? error.message : "Unknown agent error"
    };
  }
}

export async function approveToolCall(input: {
  approvalId: string;
  allow: boolean;
  mode: PermissionMode;
  model?: string;
  thinkingMode?: ThinkingMode;
  projectPath?: string;
  signal?: AbortSignal;
}): Promise<AgentRunResponse> {
  const projectKey = getProjectKey(input.projectPath);
  const projectMap = projectConversations.get(projectKey);

  if (!projectMap) {
    return {
      conversationId: "",
      status: "error",
      error: "Approval request not found — no conversations exist for this project."
    };
  }

  for (const conversation of projectMap.values()) {
    const approval = conversation.pendingApprovals.find((item) => item.id === input.approvalId);
    if (!approval) {
      continue;
    }

    conversation.pendingApprovals = conversation.pendingApprovals.filter((item) => item.id !== input.approvalId);

    const result: ToolResult = input.allow
      ? await executeTool(approval.toolCall, approval.projectPath ?? input.projectPath)
      : {
          toolCallId: approval.toolCall.id,
          name: approval.toolCall.name,
          ok: false,
          content: "User rejected this tool call."
        };

    conversation.messages.push({
      role: "tool",
      toolCallId: result.toolCallId,
      content: result.content
    });

    return await continueConversation(conversation, input.mode, [result], {
      model: input.model,
      thinkingMode: input.thinkingMode,
      projectPath: approval.projectPath ?? input.projectPath,
      signal: input.signal
    });
  }

  return {
    conversationId: "",
    status: "error",
    error: "Approval request not found in the current project scope."
  };
}
