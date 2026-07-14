import { nanoid } from "nanoid";
import { callAiStream, type ThinkingMode } from "../providers/aiProvider";
import { getToolCallRisk } from "../security/permissions";
import { evaluatePermission, type PermissionDecision } from "../security/permissionRules";
import { executeTool } from "../runtime/tools";
import { runHooks } from "./hooks";
import type { AgentMessage, PendingApproval, PermissionMode, StreamEvent, TaskPlan, ToolCall, ToolResult, ToolRisk } from "../shared/types";
import {
  appendConversationMessage,
  deletePendingApproval,
  getConversationById,
  getOrCreateConversation,
  getPendingApprovalById,
  recordAgentUsageEvent,
  recordAuditEvent,
  savePendingApproval
} from "../storage/database";

interface Conversation {
  id: string;
  projectPath: string;
  messages: AgentMessage[];
  pendingApprovals: PendingApproval[];
  toolCallQueue: ToolCall[];
}

/** 按项目路径隔离会话，同一个项目下的不同会话互不干扰。 */
const projectConversations = new Map<string, Map<string, Conversation>>();
const MAX_AGENT_STEPS = 24;

function workflowEvent(phase: Extract<StreamEvent, { type: "workflow_state" }> ["phase"], label: string): StreamEvent {
  return { type: "workflow_state", phase, label };
}

function toolWorkflowEvent(toolCall: ToolCall): StreamEvent {
  const name = toolCall.name;

  if (name === "read_file") return workflowEvent("inspecting", "正在读取文件");
  if (name === "list_files" || name === "inspect_tree") return workflowEvent("inspecting", "正在查看项目文件");
  if (name === "search_text") return workflowEvent("inspecting", "正在搜索代码");
  if (name === "write_file" || name === "apply_patch") return workflowEvent("executing", "正在编辑文件");
  if (name === "web_fetch") return workflowEvent("inspecting", "正在获取网页");
  if (name === "run_shell") return workflowEvent("executing", "正在执行操作");
  if (name === "start_process") return workflowEvent("executing", "正在启动进程");
  if (name === "read_process" || name === "list_processes") return workflowEvent("inspecting", "正在检查进程");
  if (name === "write_process") return workflowEvent("executing", "正在操作进程");
  if (name === "stop_process") return workflowEvent("executing", "正在停止进程");
  if (name === "git_status" || name === "git_diff") return workflowEvent("inspecting", "正在检查代码变更");
  if (name === "git_branch" || name === "git_stage" || name === "git_commit") return workflowEvent("executing", "正在执行 Git 操作");
  if (name.startsWith("mcp__")) return workflowEvent("executing", "正在调用外部工具");
  return workflowEvent("executing", "正在调用工具");
}

export function parseTaskPlan(content: string): TaskPlan | undefined {
  const headingMatch = content.match(/(?:^|\n)#{1,4}\s*(?:执行计划|任务计划|Implementation Plan|Execution Plan)\s*\n/i);
  if (!headingMatch || headingMatch.index === undefined) return undefined;
  const planBody = content.slice(headingMatch.index + headingMatch[0].length);
  const steps = [...planBody.matchAll(/^\s*(?:\d+[.)]|[-*])\s*(?:\[([ xX])\]\s*)?(.+?)\s*$/gm)]
    .map((match, index) => ({
      id: `step_${index + 1}`,
      title: match[2].replace(/\s+/g, " ").trim(),
      status: match[1]?.toLowerCase() === "x" ? "completed" as const : "pending" as const
    }))
    .filter((step) => step.title.length > 0)
    .slice(0, 8);
  if (steps.length < 2) return undefined;
  const summary = content.slice(0, headingMatch.index).replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim();
  return { summary: summary.slice(0, 320) || "计划已就绪，可以确认后开始执行。", steps };
}

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
  let settledPromptTokens = 0;
  let settledCompletionTokens = 0;
  while (true) {
    if (step >= MAX_AGENT_STEPS) {
      throw new Error(`Agent reached the ${MAX_AGENT_STEPS}-step safety limit. Refine the task or continue in a new turn.`);
    }
    if (conversation.toolCallQueue.length > 0) {
      const queueCompleted = yield* processToolCallQueueStream(conversation, mode, options, "");
      if (!queueCompleted) return;
    }

    step++;
    console.log(`[Agent] Step ${step}, messages: ${conversation.messages.length}`);
    yield workflowEvent(mode === "plan" ? "planning" : "thinking", mode === "plan" ? "正在制定计划" : "正在思考");

    let contentBuffer = "";
    let toolCalls: ToolCall[] = [];
    let currentPromptTokens = 0;
    let currentCompletionTokens = 0;
    let currentUsageWasExact = false;

    // 流式调用 AI，逐 token 输出（带 429 重试）
    let aiRetries = 0;
    let aiSuccess = false;
    while (aiRetries < 3 && !aiSuccess) {
      try {
        for await (const event of callAiStream(conversation.messages, { ...options, mode })) {
          if (event.type === "text_delta") {
            contentBuffer += event.content;
            yield { type: "text_delta", content: event.content };
          } else if (event.type === "context_snapshot") {
            yield { type: "context_snapshot", snapshot: event.snapshot };
          } else if (event.type === "usage_progress") {
            currentPromptTokens = event.usage.prompt_tokens;
            currentCompletionTokens = event.usage.completion_tokens;
            yield {
              type: "usage_progress",
              usage: {
                promptTokens: settledPromptTokens + currentPromptTokens,
                completionTokens: settledCompletionTokens + currentCompletionTokens,
                totalTokens: settledPromptTokens + settledCompletionTokens + currentPromptTokens + currentCompletionTokens
              },
              model: event.model,
              provider: event.provider
            };
          } else if (event.type === "usage") {
            const usage = {
              promptTokens: event.usage.prompt_tokens ?? 0,
              completionTokens: event.usage.completion_tokens ?? 0,
              totalTokens: event.usage.total_tokens ??
                (event.usage.prompt_tokens ?? 0) + (event.usage.completion_tokens ?? 0),
              cachedTokens: event.usage.prompt_tokens_details?.cached_tokens
            };
            currentUsageWasExact = true;
            currentPromptTokens = usage.promptTokens;
            currentCompletionTokens = usage.completionTokens;
            recordAgentUsageEvent({
              eventType: "ai_call",
              projectPath: options.projectPath,
              conversationId: conversation.id,
              requestId: options.requestId,
              model: event.model,
              provider: event.provider,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              cachedTokens: usage.cachedTokens
            });
            settledPromptTokens += usage.promptTokens;
            settledCompletionTokens += usage.completionTokens;
            // The UI shows one cumulative counter for the whole user request,
            // even when tool calls require multiple model turns.
            yield {
              type: "usage",
              usage: {
                ...usage,
                promptTokens: settledPromptTokens,
                completionTokens: settledCompletionTokens,
                totalTokens: settledPromptTokens + settledCompletionTokens
              },
              model: event.model,
              provider: event.provider
            };
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

    // Some compatible providers omit stream usage. Carry the last live estimate
    // into subsequent model turns so the cumulative counters never jump back.
    if (!currentUsageWasExact) {
      settledPromptTokens += currentPromptTokens;
      settledCompletionTokens += currentCompletionTokens;
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
      if (mode === "plan") {
        const plan = parseTaskPlan(contentBuffer);
        if (plan) yield { type: "task_plan", plan };
        yield workflowEvent("plan_ready", plan ? `计划已就绪，共 ${plan.steps.length} 步` : "规划完成，等待确认");
      } else {
        yield workflowEvent("completed", "任务已完成");
      }
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
    yield toolWorkflowEvent(toolCall);

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
      yield workflowEvent("awaiting_approval", `等待批准：${toolCall.name}`);
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
    yield workflowEvent(input.mode === "plan" ? "planning" : "preparing", input.mode === "plan" ? "正在准备计划" : "正在准备上下文");
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
    yield workflowEvent("failed", "任务运行失败");
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

    yield input.allow ? toolWorkflowEvent(approval.toolCall) : workflowEvent("executing", "正在处理审批结果");
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
  yield input.allow ? toolWorkflowEvent(storedApproval.toolCall) : workflowEvent("executing", "正在处理审批结果");
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
