import { nanoid } from "nanoid";
import { auditToolCallApproval, type ThinkingMode } from "./aiProvider";
import { callAgentStreamOptimized } from "./agentInvoker";
import { getToolCallRisk, needsApproval } from "./permissions";
import { executeTool } from "./tools";
import type { AgentMessage, PendingApproval, PermissionMode, StreamEvent, ToolCall, ToolResult, ToolRisk } from "./types";

interface Conversation {
  id: string;
  projectPath: string;
  messages: AgentMessage[];
  pendingApprovals: PendingApproval[];
  toolCallQueue: ToolCall[];
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
    pendingApprovals: [],
    toolCallQueue: []
  };
  projectMap.set(conversation.id, conversation);
  return conversation;
}

function buildApproval(
  conversationId: string,
  toolCall: ToolCall,
  projectPath?: string,
  override?: { risk?: ToolRisk; reason?: string }
): PendingApproval {
  return {
    id: nanoid(),
    conversationId,
    toolCall,
    risk: override?.risk ?? getToolCallRisk(toolCall),
    reason: override?.reason ?? `Agent 请求执行 ${toolCall.name}`,
    createdAt: new Date().toISOString(),
    projectPath
  };
}

async function evaluateToolApproval(
  mode: PermissionMode,
  toolCall: ToolCall,
  options: { model?: string; projectPath?: string; signal?: AbortSignal }
): Promise<{ requiresApproval: boolean; risk?: ToolRisk; reason?: string }> {
  if (mode === "full_access") {
    return { requiresApproval: false };
  }

  if (mode === "request_approval") {
    return { requiresApproval: needsApproval(mode, toolCall, options.projectPath) };
  }

  try {
    const audit = await auditToolCallApproval(toolCall, {
      model: options.model,
      projectPath: options.projectPath,
      signal: options.signal
    });

    if (audit) {
      return {
        requiresApproval: !audit.allow,
        risk: audit.risk,
        reason: audit.allow ? undefined : `模型自动审核：${audit.reason}`
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知审核错误";
    return {
      requiresApproval: true,
      risk: "high",
      reason: `模型自动审核失败，需要人工审批：${message}`
    };
  }

  return {
    requiresApproval: getToolCallRisk(toolCall) === "high",
    risk: getToolCallRisk(toolCall),
    reason: "模型自动审核不可用，按静态风险策略请求人工审批。"
  };
}

async function* continueConversationStream(
  conversation: Conversation,
  mode: PermissionMode,
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  let step = 0;
  while (true) {
    if (conversation.toolCallQueue.length > 0) {
      const queueCompleted = yield* processToolCallQueueStream(conversation, mode, options, "");
      if (!queueCompleted) return;
    }

    step++;
    console.log(`[Agent] Step ${step}, messages: ${conversation.messages.length}`);

    let contentBuffer = "";
    let toolCalls: ToolCall[] = [];

    // 流式调用 AI，逐 token 输出（带 429 重试）
    let aiRetries = 0;
    let aiSuccess = false;
    while (aiRetries < 3 && !aiSuccess) {
      try {
        for await (const event of callAgentStreamOptimized(conversation.messages, options)) {
          if (event.type === "text_delta") {
            const delta = event.content ?? "";
            contentBuffer += delta;
            yield { type: "text_delta", content: delta };
          } else if (event.type === "tool_calls") {
            toolCalls = event.toolCalls ?? [];
            // 当从文本提取工具调用时，用清理后的内容替换原始内容
            if (event.cleanContent !== undefined) {
              contentBuffer = event.cleanContent;
            }
          }
        }
        aiSuccess = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("429") && aiRetries < 2) {
          aiRetries++;
          const wait = 2000 * aiRetries;
          console.log(`[Agent] 429 rate limited, retry ${aiRetries}/3 after ${wait}ms`);
          yield { type: "text_delta", content: `\n\n⏳ 速率受限，等待 ${wait / 1000} 秒后重试...\n\n` };
          await new Promise((r) => setTimeout(r, wait));
          contentBuffer = "";
          toolCalls = [];
          continue;
        }
        throw error;
      }
    }

    console.log(`[Agent] AI returned: content=${contentBuffer.length}chars, toolCalls=${toolCalls.length}`);

    conversation.messages.push({
      role: "assistant",
      content: contentBuffer,
      toolCalls
    });

    if (toolCalls.length === 0) {
      yield { type: "completed", conversationId: conversation.id, answer: contentBuffer };
      return;
    }

    conversation.toolCallQueue = [...toolCalls];
    const queueCompleted = yield* processToolCallQueueStream(conversation, mode, options, contentBuffer);
    if (!queueCompleted) return;
  }
}

async function* processToolCallQueueStream(
  conversation: Conversation,
  mode: PermissionMode,
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; signal?: AbortSignal },
  contentBuffer: string
): AsyncGenerator<StreamEvent, boolean> {
  while (conversation.toolCallQueue.length > 0) {
    const toolCall = conversation.toolCallQueue[0];
    console.log(`[Agent] Executing tool: ${toolCall.name}`, JSON.stringify(toolCall.arguments).slice(0, 200));
    yield { type: "tool_call", toolCall };

    const approvalDecision = await evaluateToolApproval(mode, toolCall, {
      model: options.model,
      projectPath: options.projectPath,
      signal: options.signal
    });

    if (approvalDecision.requiresApproval) {
      const approval = buildApproval(conversation.id, toolCall, options.projectPath, approvalDecision);
      conversation.pendingApprovals = [approval];
      yield {
        type: "approval_required",
        conversationId: conversation.id,
        answer: contentBuffer,
        approvals: [approval]
      };
      return false;
    }

    conversation.toolCallQueue.shift();
    const result = await executeTool(toolCall, options.projectPath);
    console.log(`[Agent] Tool result: ok=${result.ok}, len=${result.content.length}`);
    yield { type: "tool_result", result };

    conversation.messages.push({
      role: "tool",
      toolCallId: result.toolCallId,
      content: result.content
    });
  }

  return true;
}

export async function* runAgentStream(input: {
  prompt: string;
  conversationId?: string;
  mode: PermissionMode;
  model?: string;
  thinkingMode?: ThinkingMode;
  projectPath?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const conversation = getConversation(input.conversationId, input.projectPath);
  conversation.messages.push({ role: "user", content: input.prompt });

  try {
    yield* continueConversationStream(conversation, input.mode, {
      model: input.model,
      thinkingMode: input.thinkingMode,
      projectPath: input.projectPath,
      signal: input.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    yield {
      type: "error",
      conversationId: conversation.id,
      message: error instanceof Error ? error.message : "Unknown agent error"
    };
  }
}

export async function* approveToolCallStream(input: {
  approvalId: string;
  allow: boolean;
  mode: PermissionMode;
  model?: string;
  thinkingMode?: ThinkingMode;
  projectPath?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const projectKey = getProjectKey(input.projectPath);
  const projectMap = projectConversations.get(projectKey);

  if (!projectMap) {
    yield { type: "error", conversationId: "", message: "Approval request not found — no conversations exist for this project." };
    return;
  }

  for (const conversation of projectMap.values()) {
    const approval = conversation.pendingApprovals.find((item) => item.id === input.approvalId);
    if (!approval) continue;

    conversation.pendingApprovals = conversation.pendingApprovals.filter((item) => item.id !== input.approvalId);
    if (conversation.toolCallQueue[0]?.id === approval.toolCall.id) {
      conversation.toolCallQueue.shift();
    } else {
      conversation.toolCallQueue = conversation.toolCallQueue.filter((toolCall) => toolCall.id !== approval.toolCall.id);
    }

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

    yield { type: "tool_result", result };

    try {
      yield* continueConversationStream(conversation, input.mode, {
        model: input.model,
        thinkingMode: input.thinkingMode,
        projectPath: approval.projectPath ?? input.projectPath,
        signal: input.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      yield {
        type: "error",
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : "Unknown agent error"
      };
    }
    return;
  }

  yield { type: "error", conversationId: "", message: "Approval request not found in the current project scope." };
}
