import { nanoid } from "nanoid";
import { callAiStream, type ThinkingMode } from "./aiProvider";
import { getToolCallRisk } from "./permissions";
import { evaluatePermission, type PermissionDecision } from "./permissionRules";
import { executeTool } from "./tools";
import { runHooks } from "./hooks";
import type { AgentMessage, PendingApproval, PermissionMode, StreamEvent, ToolCall, ToolResult, ToolRisk } from "./types";
import {
  appendConversationMessage,
  deletePendingApproval,
  getConversationById,
  getOrCreateConversation,
  getPendingApprovalById,
  recordAgentUsageEvent,
  recordAuditEvent,
  savePendingApproval
} from "./localDatabase";

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

  const stored = getOrCreateConversation({ conversationId, projectPath: projectKey });
  const conversation: Conversation = {
    id: stored.id,
    projectPath: projectKey,
    messages: stored.messages,
    pendingApprovals: stored.pendingApprovals,
    toolCallQueue: []
  };
  projectMap.set(conversation.id, conversation);
  return conversation;
}

function buildApproval(
  conversationId: string,
  toolCall: ToolCall,
  projectPath?: string,
  override?: { risk?: ToolRisk; reason?: string; remainingToolQueue?: ToolCall[]; resumeInput?: PendingApproval["resumeInput"] }
): PendingApproval {
  return {
    id: nanoid(),
    conversationId,
    toolCall,
    risk: override?.risk ?? getToolCallRisk(toolCall),
    reason: override?.reason ?? `Agent 请求执行 ${toolCall.name}`,
    createdAt: new Date().toISOString(),
    projectPath,
    conversationSnapshotId: conversationId,
    remainingToolQueue: override?.remainingToolQueue,
    resumeInput: override?.resumeInput
  };
}

function appendToolResultMessage(conversation: Conversation, result: ToolResult) {
  const message = {
    role: "tool" as const,
    toolCallId: result.toolCallId,
    content: result.content
  };
  conversation.messages.push(message);
  appendConversationMessage(conversation.id, message);
}

async function* continueConversationStream(
  conversation: Conversation,
  mode: PermissionMode,
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; requestId?: string; signal?: AbortSignal }
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
        for await (const event of callAiStream(conversation.messages, options)) {
          if (event.type === "text_delta") {
            contentBuffer += event.content;
            yield { type: "text_delta", content: event.content };
          } else if (event.type === "usage") {
            recordAgentUsageEvent({
              eventType: "ai_call",
              projectPath: options.projectPath,
              conversationId: conversation.id,
              requestId: options.requestId,
              model: event.model,
              provider: event.provider,
              promptTokens: event.usage.prompt_tokens,
              completionTokens: event.usage.completion_tokens,
              totalTokens: event.usage.total_tokens,
              cachedTokens: event.usage.prompt_tokens_details?.cached_tokens
            });
          } else if (event.type === "tool_calls") {
            toolCalls = event.toolCalls;
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
    appendConversationMessage(conversation.id, {
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

    const preHook = await runHooks("PreToolUse", {
      projectPath: options.projectPath,
      conversationId: conversation.id,
      toolName: toolCall.name,
      payload: toolCall
    });
    if (preHook.blocked) {
      conversation.toolCallQueue.shift();
      const result: ToolResult = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        content: `PreToolUse hook blocked this call: ${preHook.messages.join("\n")}`
      };
      yield { type: "tool_result", result };
      appendToolResultMessage(conversation, result);
      continue;
    }

    const approvalDecision = await evaluatePermission(mode === "default" ? "workspace_write" : mode, toolCall, options.projectPath);
    yield {
      type: "permission_decision",
      toolCallId: toolCall.id,
      effect: approvalDecision.effect,
      reason: approvalDecision.reason
    };

    if (approvalDecision.effect === "deny") {
      conversation.toolCallQueue.shift();
      const result: ToolResult = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: false,
        content: `Permission denied: ${approvalDecision.reason}`
      };
      recordAuditEvent({
        projectPath: options.projectPath,
        conversationId: conversation.id,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        permissionEffect: "deny",
        permissionReason: approvalDecision.reason,
        ok: false,
        outputSummary: result.content
      });
      yield { type: "tool_result", result };
      appendToolResultMessage(conversation, result);
      continue;
    }

    if (approvalDecision.requiresApproval) {
      await runHooks("PermissionRequest", {
        projectPath: options.projectPath,
        conversationId: conversation.id,
        toolName: toolCall.name,
        payload: { toolCall, approvalDecision }
      });
      const approval = buildApproval(conversation.id, toolCall, options.projectPath, {
        ...approvalDecision,
        remainingToolQueue: conversation.toolCallQueue.slice(1),
        resumeInput: {
          mode,
          model: options.model,
          thinkingMode: options.thinkingMode,
          projectPath: options.projectPath
        }
      });
      conversation.pendingApprovals = [approval];
      savePendingApproval(approval);
      recordAuditEvent({
        projectPath: options.projectPath,
        conversationId: conversation.id,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        permissionEffect: "ask",
        permissionReason: approvalDecision.reason,
        ok: undefined,
        outputSummary: "Approval required"
      });
      yield {
        type: "approval_required",
        conversationId: conversation.id,
        answer: contentBuffer,
        approvals: [approval]
      };
      return false;
    }

    conversation.toolCallQueue.shift();
    const result = await executeTool(toolCall, options.projectPath, {
      conversationId: conversation.id,
      permissionEffect: approvalDecision.effect,
      permissionReason: approvalDecision.reason
    });
    await runHooks("PostToolUse", {
      projectPath: options.projectPath,
      conversationId: conversation.id,
      toolName: toolCall.name,
      payload: { toolCall, result }
    });
    console.log(`[Agent] Tool result: ok=${result.ok}, len=${result.content.length}`);
    yield { type: "tool_result", result };
    if (result.diffs && result.diffs.length > 0) {
      yield { type: "diff_created", diffs: result.diffs, auditEventId: result.auditEventId };
    }

    appendToolResultMessage(conversation, result);
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
  const requestId = nanoid();
  const sessionWasExisting = Boolean(input.conversationId && getConversationById(input.conversationId));
  const conversation = getConversation(input.conversationId, input.projectPath);
  recordAgentUsageEvent({
    eventType: "prompt",
    projectPath: input.projectPath,
    conversationId: conversation.id,
    requestId,
    model: input.model,
    sessionWasExisting
  });
  await runHooks(input.conversationId ? "UserPromptSubmit" : "SessionStart", {
    projectPath: input.projectPath,
    conversationId: conversation.id,
    payload: { prompt: input.prompt }
  });
  conversation.messages.push({ role: "user", content: input.prompt });
  appendConversationMessage(conversation.id, { role: "user", content: input.prompt });

  try {
    yield { type: "run_started", conversationId: conversation.id };
    yield* continueConversationStream(conversation, input.mode, {
      model: input.model,
      thinkingMode: input.thinkingMode,
      projectPath: input.projectPath,
      requestId,
      signal: input.signal
    });
    await runHooks("Stop", { projectPath: input.projectPath, conversationId: conversation.id });
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

  const conversations = projectMap ? [...projectMap.values()] : [];
  for (const conversation of conversations) {
    const approval = conversation.pendingApprovals.find((item) => item.id === input.approvalId);
    if (!approval) continue;

    conversation.pendingApprovals = conversation.pendingApprovals.filter((item) => item.id !== input.approvalId);
    deletePendingApproval(input.approvalId);
    if (conversation.toolCallQueue[0]?.id === approval.toolCall.id) {
      conversation.toolCallQueue.shift();
    } else {
      conversation.toolCallQueue = conversation.toolCallQueue.filter((toolCall) => toolCall.id !== approval.toolCall.id);
    }

    const result: ToolResult = input.allow
      ? await executeTool(approval.toolCall, approval.projectPath ?? input.projectPath, {
          conversationId: conversation.id,
          permissionEffect: "allow",
          permissionReason: "User approved this tool call."
        })
      : {
          toolCallId: approval.toolCall.id,
          name: approval.toolCall.name,
          ok: false,
          content: "User rejected this tool call."
        };

    appendToolResultMessage(conversation, result);

    yield { type: "tool_result", result };
    if (result.diffs && result.diffs.length > 0) {
      yield { type: "diff_created", diffs: result.diffs, auditEventId: result.auditEventId };
    }

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

  const storedApproval = getPendingApprovalById(input.approvalId);
  if (!storedApproval) {
    yield { type: "error", conversationId: "", message: "Approval request not found in the current project scope." };
    return;
  }

  const storedConversation = getConversationById(storedApproval.conversationId);
  if (!storedConversation) {
    yield { type: "error", conversationId: storedApproval.conversationId, message: "Stored conversation for approval was not found." };
    return;
  }

  const conversation: Conversation = {
    id: storedConversation.id,
    projectPath: storedConversation.projectPath,
    messages: storedConversation.messages,
    pendingApprovals: storedConversation.pendingApprovals.filter((approval) => approval.id !== input.approvalId),
    toolCallQueue: storedApproval.remainingToolQueue ?? []
  };
  let projectMapForResume = projectConversations.get(storedConversation.projectPath);
  if (!projectMapForResume) {
    projectMapForResume = new Map();
    projectConversations.set(storedConversation.projectPath, projectMapForResume);
  }
  projectMapForResume.set(conversation.id, conversation);
  deletePendingApproval(input.approvalId);

  const projectPath = storedApproval.projectPath ?? input.projectPath;
  const result: ToolResult = input.allow
    ? await executeTool(storedApproval.toolCall, projectPath, {
        conversationId: conversation.id,
        permissionEffect: "allow",
        permissionReason: "User approved this recovered tool call."
      })
    : {
        toolCallId: storedApproval.toolCall.id,
        name: storedApproval.toolCall.name,
        ok: false,
        content: "User rejected this recovered tool call."
      };

  appendToolResultMessage(conversation, result);
  yield { type: "tool_result", result };
  if (result.diffs && result.diffs.length > 0) {
    yield { type: "diff_created", diffs: result.diffs, auditEventId: result.auditEventId };
  }

  yield* continueConversationStream(conversation, input.mode, {
    model: input.model,
    thinkingMode: input.thinkingMode,
    projectPath,
    signal: input.signal
  });
}
