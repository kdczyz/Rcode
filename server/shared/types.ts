export type PermissionMode = "default" | "plan" | "workspace_write" | "full_access" | "custom";

export type LearningRunStatus = "saved" | "no_candidate" | "skipped" | "failed";

export type WorkflowPhase =
  | "preparing"
  | "planning"
  | "thinking"
  | "inspecting"
  | "executing"
  | "awaiting_approval"
  | "plan_ready"
  | "completed"
  | "stopped"
  | "failed";

export interface ContextSnapshot {
  budgetTokens: number;
  estimatedTokens: number;
  messageCount: number;
  includedMessageCount: number;
  compactedMessageCount: number;
  projectContextChars: number;
  activeSkills: string[];
}

export interface TaskPlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TaskPlan {
  summary: string;
  steps: TaskPlanStep[];
}

export type LegacyPermissionMode = "request_approval" | "auto_approve";

export type ToolRisk = "low" | "medium" | "high";

export type BuiltinToolName =
  | "read_file"
  | "write_file"
  | "list_files"
  | "search_text"
  | "inspect_tree"
  | "record_learning"
  | "apply_patch"
  | "web_fetch"
  | "run_shell"
  | "start_process"
  | "read_process"
  | "write_process"
  | "stop_process"
  | "list_processes"
  | "git_status"
  | "git_diff"
  | "git_branch"
  | "git_stage"
  | "git_commit";

export type AgentToolName = BuiltinToolName | `mcp__${string}__${string}` | string;

export type PermissionEffect = "allow" | "ask" | "deny";
export type EnforcementDecision = "guarded" | "requires_approval" | "denied" | "unavailable";
export type PermissionTargetType = "tool" | "path" | "command" | "url" | "mcp";
export type PermissionScope = "user" | "project" | "managed";

export interface PermissionRule {
  id: string;
  effect: PermissionEffect;
  targetType: PermissionTargetType;
  pattern: string;
  scope: PermissionScope;
  enabled: boolean;
}

export interface ToolDefinition {
  id?: AgentToolName;
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  source: "builtin" | "mcp";
  sourceId?: string;
  risk: ToolRisk;
  requiresSandbox: boolean;
  requiresExecutor?: boolean;
  defaultApproval: PermissionEffect;
  approvalMode?: PermissionEffect;
}

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
  attachments?: AgentAttachment[];
  summary?: string;
  exitCode?: number;
  artifacts?: Array<{ id: string; label: string; kind: string }>;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  diffs?: DiffResult[];
  auditEventId?: string;
  process?: ManagedProcessSnapshot;
  /** write_file 时包含的 diff 信息 */
  diff?: DiffResult;
}

export type ManagedProcessStatus = "running" | "exited" | "stopped" | "failed";

export interface ManagedProcessSnapshot {
  id: string;
  command: string;
  label?: string;
  cwd: string;
  projectPath: string;
  pid?: number;
  status: ManagedProcessStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
  output: string;
  outputVersion: number;
}

export interface ShellAnalysis {
  command: string;
  cwd: string;
  cwdInsideWorkspace: boolean;
  mentionsOutsideWorkspace: boolean;
  redirectsOutsideWorkspace: boolean;
  mayUseNetwork: boolean;
  destructive: boolean;
  leaksEnvironment: boolean;
  backgroundProcess: boolean;
  interactive: boolean;
  riskFlags: string[];
  blockedReason?: string;
}

export interface ExecutorResult {
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  blockedReason?: string;
  riskFlags: string[];
  cwd: string;
  argv: string[];
  executorKind: "portable";
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
  conversationSnapshotId?: string;
  remainingToolQueue?: ToolCall[];
  resumeInput?: {
    mode?: PermissionMode;
    model?: string;
    thinkingMode?: string;
    projectPath?: string;
  };
}

export interface AgentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  dataUrl?: string;
  text?: string;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  attachments?: AgentAttachment[];
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
  | { type: "run_started"; conversationId: string }
  | { type: "workflow_state"; phase: WorkflowPhase; label: string }
  | { type: "context_snapshot"; snapshot: ContextSnapshot }
  | { type: "task_plan"; plan: TaskPlan }
  | { type: "text_delta"; content: string }
  | {
      type: "billing_usage";
      usage: {
        rawInputTokens: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      };
      model: string;
      provider: string;
    }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "permission_decision"; toolCallId: string; effect: PermissionEffect; reason: string }
  | { type: "tool_result"; result: ToolResult }
  | { type: "diff_created"; diffs: DiffResult[]; auditEventId?: string }
  | { type: "learning_result"; status: LearningRunStatus; recordsSaved: number; reason: string; createdAt: string }
  | { type: "approval_required"; conversationId: string; answer: string; approvals: PendingApproval[] }
  | { type: "completed"; conversationId: string; answer: string }
  | { type: "error"; conversationId: string; message: string };
