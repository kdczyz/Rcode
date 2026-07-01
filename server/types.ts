export type PermissionMode = "request_approval" | "auto_approve" | "full_access";

export type ToolRisk = "low" | "medium" | "high";

export type AgentToolName = "read_file" | "write_file" | "web_fetch" | "run_shell";

export interface ToolCall {
  id: string;
  name: AgentToolName;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: AgentToolName;
  ok: boolean;
  content: string;
  /** write_file 时包含的 diff 信息 */
  diff?: DiffResult;
}

export interface DiffResult {
  filePath: string;
  oldContent: string | null;
  newContent: string;
  /** 各行的类型: "same" | "add" | "remove" */
  lines: Array<{ type: "same" | "add" | "remove"; content: string; oldLine?: number; newLine?: number }>;
  addedLines: number;
  removedLines: number;
}

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolCall: ToolCall;
  reason: string;
  risk: ToolRisk;
  createdAt: string;
  projectPath?: string;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface AgentRunResponse {
  conversationId: string;
  status: "completed" | "approval_required" | "error";
  answer?: string;
  pendingApprovals?: PendingApproval[];
  toolResults?: ToolResult[];
  error?: string;
}

export type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "approval_required"; conversationId: string; answer: string; approvals: PendingApproval[] }
  | { type: "completed"; conversationId: string; answer: string }
  | { type: "error"; conversationId: string; message: string };
