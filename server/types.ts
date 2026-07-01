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
