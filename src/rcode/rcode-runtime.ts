/**
 * AgentProvider implementation backed by the Rcode server.
 *
 * DeepSeek-GUI's renderer talks to an AgentProvider (see agent/types.ts).
 * The original implementation targets the codewhale runtime over IPC; this
 * adapter re-implements the same contract against Rcode's Express API
 * (/api/agent/run SSE, /api/agent/approve, /api/health) plus local thread
 * persistence (rcode/thread-store).
 */

import type {
  AgentProvider,
  AgentProviderId,
  ChatBlock,
  NormalizedThread,
  ThreadEventSink,
  ThreadListOptions,
  ToolItemKind,
  UserInputAnswer
} from "../agent/types";
import { apiFetch, apiUrl, apiHeaders } from "./api-client";
import {
  appendMessage,
  bumpThreadSeq,
  createThread as storeCreateThread,
  deleteThread as storeDeleteThread,
  getThread,
  listThreads as storeListThreads,
  updateMessage,
  updateThread,
  createId,
  type RcodeMessage,
  type RcodeThread
} from "./thread-store";

/* ------------------------------ SSE framing ----------------------------- */

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLines = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        try {
          yield JSON.parse(dataLines.join("\n")) as SseEvent;
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/* --------------------------- event buffer model -------------------------- */

type BufferedEvent = {
  seq: number;
  apply: (sink: ThreadEventSink) => void;
};

type ActiveRun = {
  turnId: string;
  abort: AbortController;
  events: BufferedEvent[];
  sinks: Set<ThreadEventSink>;
  status: "running" | "done" | "error";
  assistantMessageId?: string;
  assistantText: string;
  reasoningText: string;
  toolMessageByCallId: Map<string, string>;
};

/* ----------------------------- helper mapping ---------------------------- */

const COMMAND_TOOLS = new Set(["execute_command", "run_command", "bash", "shell", "terminal"]);
const FILE_CHANGE_TOOLS = new Set([
  "edit_file",
  "write_file",
  "apply_patch",
  "create_file",
  "delete_file",
  "rename_file",
  "apply_diff"
]);

function toolKindOf(name?: string): ToolItemKind {
  if (!name) return "tool_call";
  if (COMMAND_TOOLS.has(name)) return "command_execution";
  if (FILE_CHANGE_TOOLS.has(name)) return "file_change";
  return "tool_call";
}

function summarizeToolCall(name: string, args?: Record<string, unknown>): string {
  if (!args) return name;
  const target =
    (typeof args.path === "string" && args.path) ||
    (typeof args.filePath === "string" && args.filePath) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.command === "string" && args.command) ||
    (typeof args.cmd === "string" && args.cmd) ||
    (typeof args.query === "string" && args.query) ||
    "";
  return target ? `${name}: ${target}` : name;
}

function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Map Rcode permission-mode naming used by the composer onto the server. */
function toServerMode(mode?: string): string {
  if (!mode || mode === "agent") return "workspace_write";
  if (mode === "plan") return "plan";
  return mode;
}

function messageToBlock(message: RcodeMessage): ChatBlock {
  if (message.role === "user") {
    return { kind: "user", id: message.id, createdAt: message.createdAt, text: message.content };
  }
  if (message.role === "assistant") {
    return { kind: "assistant", id: message.id, createdAt: message.createdAt, text: message.content };
  }
  const status: "running" | "success" | "error" =
    message.status === "running" ? "running" : message.toolOk === false || message.status === "error" ? "error" : "success";
  return {
    kind: "tool",
    id: message.id,
    createdAt: message.createdAt,
    summary: message.toolSummary ?? message.toolName ?? "tool",
    status,
    toolKind: toolKindOf(message.toolName),
    detail: message.content ? clip(message.content) : undefined,
    filePath: message.diffFilePath,
    meta: message.toolArgs ? { arguments: message.toolArgs } : undefined
  };
}

/* ------------------------------ the provider ----------------------------- */

export class RcodeRuntimeProvider implements AgentProvider {
  readonly id: AgentProviderId = "deepseek-runtime";
  readonly displayName = "Rcode Runtime";

  private activeRuns = new Map<string, ActiveRun>();

  getCapabilities() {
    return { interrupt: true, stream: true, approvals: true, attachFiles: false };
  }

  async connect(): Promise<void> {
    const response = await apiFetch("/api/health");
    if (!response.ok) throw new Error(`Rcode server unhealthy (${response.status})`);
  }

  /* ------------------------------ thread CRUD ---------------------------- */

  async listThreads(options?: ThreadListOptions): Promise<NormalizedThread[]> {
    let threads = storeListThreads({ includeArchived: options?.includeArchived || options?.archivedOnly });
    if (options?.archivedOnly) threads = threads.filter((t) => t.archived);
    if (options?.search) {
      const q = options.search.toLowerCase();
      threads = threads.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.projectPath.toLowerCase().includes(q) ||
          t.messages.some((m) => m.content.toLowerCase().includes(q))
      );
    }
    if (options?.limit) threads = threads.slice(0, options.limit);
    return threads.map((thread) => this.toNormalized(thread));
  }

  async createThread(input: { workspace?: string; title?: string; mode?: string }): Promise<NormalizedThread> {
    const thread = storeCreateThread({
      projectPath: input.workspace ?? "",
      title: input.title,
      mode: input.mode
    });
    return this.toNormalized(thread);
  }

  async getThreadDetail(threadId: string): Promise<{
    blocks: ChatBlock[];
    latestSeq: number;
    threadStatus?: string;
    latestTurnId?: string;
    latestUserMessageId?: string;
    turnDurationByUserId?: Record<string, number>;
  }> {
    const thread = getThread(threadId);
    if (!thread) throw new Error("thread not found");
    const run = this.activeRuns.get(threadId);
    const blocks = thread.messages.map(messageToBlock);
    const latestUser = [...thread.messages].reverse().find((m) => m.role === "user");
    return {
      blocks,
      latestSeq: thread.lastSeq,
      threadStatus: run?.status === "running" ? "running" : "idle",
      latestTurnId: run?.turnId,
      latestUserMessageId: latestUser?.id
    };
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    updateThread(threadId, { title });
  }

  async archiveThread(threadId: string, archived: boolean): Promise<void> {
    updateThread(threadId, { archived });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.activeRuns.get(threadId)?.abort.abort();
    this.activeRuns.delete(threadId);
    storeDeleteThread(threadId);
  }

  /* ---------------------------- message sending -------------------------- */

  async sendUserMessage(
    threadId: string,
    text: string,
    options?: { mode?: string; model?: string }
  ): Promise<{ turnId: string; threadId: string; userMessageItemId?: string }> {
    const thread = getThread(threadId);
    if (!thread) throw new Error("thread not found");
    const existing = this.activeRuns.get(threadId);
    if (existing?.status === "running") throw new Error("Active turn in progress");

    const turnId = createId("turn");
    const userMessageId = createId("msg");
    appendMessage(threadId, {
      id: userMessageId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      status: "completed"
    });

    const run: ActiveRun = {
      turnId,
      abort: new AbortController(),
      events: [],
      sinks: new Set(),
      status: "running",
      assistantText: "",
      reasoningText: "",
      toolMessageByCallId: new Map()
    };
    this.activeRuns.set(threadId, run);

    if (options?.model) updateThread(threadId, { model: options.model });
    if (options?.mode) updateThread(threadId, { mode: options.mode });

    void this.consumeRunStream(threadId, run, text, options).catch((error) => {
      this.pushEvent(threadId, run, (sink) => sink.onError(error instanceof Error ? error : new Error(String(error))));
      run.status = "error";
    });

    return { turnId, threadId, userMessageItemId: userMessageId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const run = this.activeRuns.get(threadId);
    run?.abort.abort();
  }

  async subscribeThreadEvents(
    threadId: string,
    sinceSeq: number,
    sink: ThreadEventSink,
    signal: AbortSignal
  ): Promise<void> {
    const run = this.activeRuns.get(threadId);
    if (!run) return;
    run.sinks.add(sink);
    for (const event of run.events) {
      if (event.seq > sinceSeq) {
        try {
          event.apply(sink);
        } catch {
          /* keep replaying */
        }
      }
    }
    signal.addEventListener("abort", () => run.sinks.delete(sink), { once: true });
    if (run.status !== "running") {
      run.sinks.delete(sink);
    }
  }

  /* ------------------------------- approvals ----------------------------- */

  async submitApprovalDecision(approvalId: string, decision: "allow" | "deny"): Promise<void> {
    // Find the thread that owns the pending approval run.
    const entry = [...this.activeRuns.entries()].find(([, run]) => run.status === "running" || run.status === "done");
    if (!entry) throw new Error("no active run for approval");
    const [threadId, run] = entry;
    const thread = getThread(threadId);
    if (!thread) throw new Error("thread not found");

    const headers = await apiHeaders();
    const response = await fetch(apiUrl("/api/agent/approve"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        approvalId,
        allow: decision === "allow",
        mode: toServerMode(thread.mode),
        model: thread.model || undefined,
        projectPath: thread.projectPath || undefined,
        conversationId: thread.conversationId
      }),
      signal: run.abort.signal
    });
    if (!response.ok) throw new Error(`approve failed (${response.status})`);

    run.status = "running";
    await this.consumeSseIntoRun(threadId, run, response);
  }

  /* ---------------------------- SSE consumption -------------------------- */

  private async consumeRunStream(
    threadId: string,
    run: ActiveRun,
    text: string,
    options?: { mode?: string; model?: string }
  ): Promise<void> {
    const thread = getThread(threadId);
    if (!thread) return;
    const headers = await apiHeaders();
    const response = await fetch(apiUrl("/api/agent/run"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: text,
        conversationId: thread.conversationId,
        mode: toServerMode(options?.mode ?? thread.mode),
        model: options?.model ?? (thread.model || undefined),
        projectPath: thread.projectPath || undefined
      }),
      signal: run.abort.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`agent run failed (${response.status}): ${body.slice(0, 200)}`);
    }
    await this.consumeSseIntoRun(threadId, run, response);
  }

  private async consumeSseIntoRun(threadId: string, run: ActiveRun, response: Response): Promise<void> {
    try {
      for await (const event of readSse(response)) {
        this.handleStreamEvent(threadId, run, event);
        if (event.type === "completed" || event.type === "error") break;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        this.pushEvent(threadId, run, (sink) => sink.onTurnComplete());
      } else {
        throw error;
      }
    } finally {
      if (run.status === "running") run.status = "done";
    }
  }

  private handleStreamEvent(threadId: string, run: ActiveRun, event: SseEvent): void {
    switch (event.type) {
      case "run_started": {
        const conversationId = typeof event.conversationId === "string" ? event.conversationId : undefined;
        if (conversationId) updateThread(threadId, { conversationId });
        break;
      }
      case "text_delta": {
        const text = typeof event.content === "string" ? event.content : "";
        if (!text) break;
        if (!run.assistantMessageId) {
          run.assistantMessageId = createId("msg");
          appendMessage(threadId, {
            id: run.assistantMessageId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            status: "running"
          });
        }
        run.assistantText += text;
        updateMessage(threadId, run.assistantMessageId, { content: run.assistantText });
        this.pushEvent(threadId, run, (sink) => sink.onDeltas([{ text, kind: "agent_message" }]));
        break;
      }
      case "thinking": {
        const text = typeof event.text === "string" ? event.text : "";
        if (!text) break;
        run.reasoningText += text;
        this.pushEvent(threadId, run, (sink) => sink.onDeltas([{ text, kind: "agent_reasoning" }]));
        break;
      }
      case "tool_call": {
        const toolCall = event.toolCall as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!toolCall?.id) break;
        const name = toolCall.name ?? "tool";
        const summary = summarizeToolCall(name, toolCall.arguments);
        const messageId = createId("msg");
        run.toolMessageByCallId.set(toolCall.id, messageId);
        appendMessage(threadId, {
          id: messageId,
          role: "tool",
          content: "",
          createdAt: new Date().toISOString(),
          toolName: name,
          toolArgs: toolCall.arguments,
          toolCallId: toolCall.id,
          toolSummary: summary,
          status: "running"
        });
        this.pushEvent(threadId, run, (sink) =>
          sink.onTool({
            itemId: messageId,
            summary,
            status: "running",
            toolKind: toolKindOf(name),
            meta: toolCall.arguments ? { arguments: toolCall.arguments } : undefined
          })
        );
        break;
      }
      case "tool_result": {
        const result = event.result as
          | { toolCallId?: string; name?: string; ok?: boolean; content?: string; summary?: string; diffs?: Array<{ filePath?: string }> }
          | undefined;
        if (!result) break;
        const messageId = (result.toolCallId && run.toolMessageByCallId.get(result.toolCallId)) ?? createId("msg");
        const ok = result.ok !== false;
        const diffPath = result.diffs?.[0]?.filePath;
        if (!run.toolMessageByCallId.has(result.toolCallId ?? "")) {
          run.toolMessageByCallId.set(result.toolCallId ?? messageId, messageId);
          appendMessage(threadId, {
            id: messageId,
            role: "tool",
            content: "",
            createdAt: new Date().toISOString(),
            toolName: result.name,
            toolCallId: result.toolCallId,
            status: "running"
          });
        }
        updateMessage(threadId, messageId, {
          content: clip(result.content ?? "", 20000),
          toolOk: ok,
          status: "completed",
          toolSummary: result.summary || summarizeToolCall(result.name ?? "tool"),
          ...(diffPath ? { diffFilePath: diffPath } : {})
        });
        this.pushEvent(threadId, run, (sink) =>
          sink.onTool({
            itemId: messageId,
            summary: result.summary || result.name || "tool",
            status: ok ? "success" : "error",
            toolKind: toolKindOf(result.name),
            detail: result.content ? clip(result.content) : undefined,
            filePath: diffPath
          })
        );
        break;
      }
      case "diff_created": {
        const diffs = event.diffs as Array<{ filePath?: string }> | undefined;
        const firstPath = diffs?.[0]?.filePath;
        if (!firstPath) break;
        const lastToolMessageId = [...run.toolMessageByCallId.values()].pop();
        if (lastToolMessageId) updateMessage(threadId, lastToolMessageId, { diffFilePath: firstPath });
        break;
      }
      case "approval_required": {
        const approvals = event.approvals as Array<{ id?: string; reason?: string; toolCall?: { name?: string } }> | undefined;
        const approval = approvals?.[0];
        if (!approval?.id) break;
        this.pushEvent(threadId, run, (sink) =>
          sink.onApproval({
            approvalId: approval.id as string,
            summary: approval.reason ?? "Tool call requires approval",
            toolName: approval.toolCall?.name
          })
        );
        break;
      }
      case "completed": {
        const answer = typeof event.answer === "string" ? event.answer : "";
        // Fallback: some providers deliver the whole reply only in `answer`
        // without streaming text_delta frames.
        if (answer && !run.assistantText) {
          if (!run.assistantMessageId) {
            run.assistantMessageId = createId("msg");
            appendMessage(threadId, {
              id: run.assistantMessageId,
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
              status: "running"
            });
          }
          run.assistantText = answer;
          updateMessage(threadId, run.assistantMessageId, { content: answer });
          this.pushEvent(threadId, run, (sink) => sink.onDeltas([{ text: answer, kind: "agent_message" }]));
        }
        if (run.assistantMessageId) {
          updateMessage(threadId, run.assistantMessageId, { status: "completed" });
        }
        run.status = "done";
        this.pushEvent(threadId, run, (sink) => sink.onTurnComplete());
        break;
      }
      case "error": {
        const message = typeof event.message === "string" ? event.message : "Agent error";
        if (run.assistantMessageId) updateMessage(threadId, run.assistantMessageId, { status: "error" });
        run.status = "error";
        this.pushEvent(threadId, run, (sink) => sink.onError(new Error(message)));
        break;
      }
      default:
        // workflow_state, context_snapshot, reasoning_config, task_plan,
        // billing_usage, permission_decision, learning_result — ignored by the
        // DeepSeek-GUI block model for now.
        break;
    }
  }

  private pushEvent(threadId: string, run: ActiveRun, apply: (sink: ThreadEventSink) => void): void {
    const seq = bumpThreadSeq(threadId);
    run.events.push({ seq, apply });
    for (const sink of run.sinks) {
      try {
        sink.onSeq(seq);
        apply(sink);
      } catch {
        /* a broken sink must not kill the stream */
      }
    }
  }

  /* --------------------------------- misc -------------------------------- */

  private toNormalized(thread: RcodeThread): NormalizedThread {
    const lastMessage = thread.messages[thread.messages.length - 1];
    const run = this.activeRuns.get(thread.id);
    return {
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
      model: thread.model,
      mode: thread.mode,
      workspace: thread.projectPath,
      archived: thread.archived,
      preview: lastMessage?.content.slice(0, 120),
      status: run?.status === "running" ? "running" : "idle",
      latestTurnStatus: run?.status === "running" ? "running" : undefined
    };
  }

  async submitUserInputResponse(_requestId: string, _answers: UserInputAnswer[]): Promise<void> {
    throw new Error("user input requests are not supported by the Rcode runtime");
  }

  async cancelUserInput(_requestId: string): Promise<void> {
    /* no-op */
  }
}
