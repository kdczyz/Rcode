import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { listLearningRecords, listMemories, searchMemories } from "../storage/database";
import { getWorkspaceRoot } from "../security/sandbox";
import { activateSkills } from "./skills";
import { getMemorySettings } from "./memory";
import type { AgentMessage, ContextSnapshot } from "../shared/types";
import { BYTES_PER_TOKEN, estimateTokens } from "./tokenBudget";
import {
  buildTranscriptHint,
  COMPACTION_DIR,
  writeSegment,
  type CompactionDetail,
  type CompactionMode
} from "./compactionSegments";
import { prepareForSummarization, truncateTrailingIncompleteToolCall } from "./contextStrip";
import { pruneToolResults, type ToolResultPruningConfig, defaultToolResultPruningConfig } from "./toolResultPruning";

const DEFAULT_CONTEXT_BUDGET_TOKENS = 16_000;

export interface ProjectContextBundle {
  content: string;
  activeSkills: string[];
}

export interface CompactedContext {
  messages: AgentMessage[];
  snapshot: Omit<ContextSnapshot, "projectContextChars" | "activeSkills">;
}

async function readIfExists(filePath: string, maxChars: number) {
  if (!existsSync(filePath)) return "";
  const content = await readFile(filePath, "utf8");
  return content.slice(0, maxChars);
}

async function readRuleFiles(projectPath: string) {
  const rulesDir = path.join(projectPath, ".agent", "rules");
  if (!existsSync(rulesDir)) return "";
  const entries = await readdir(rulesDir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(rulesDir, entry.name);
    parts.push(`Rule ${entry.name}:\n${await readIfExists(filePath, 4000)}`);
  }
  return parts.join("\n\n").slice(0, 12000);
}

export async function buildProjectContextBundle(projectPath?: string, prompt = "", requestedSkillNames: string[] = []): Promise<ProjectContextBundle> {
  const workspaceRoot = getWorkspaceRoot(projectPath);
  const memorySettings = getMemorySettings();
  const agentsMd = await readIfExists(path.join(workspaceRoot, "AGENTS.md"), 8000);
  const rules = await readRuleFiles(workspaceRoot);
  const memories = memorySettings.longTerm.enabled
    ? memorySettings.longTerm.retrieval === "hybrid" && prompt.trim()
      ? searchMemories(workspaceRoot, prompt, memorySettings.longTerm.maxResults, memorySettings.longTerm.minImportance)
      : listMemories(workspaceRoot, memorySettings.longTerm.maxResults).filter((memory) => memory.importance >= memorySettings.longTerm.minImportance)
    : [];
  const memoryText = memories
    .map((memory) => `- [${memory.kind}; importance=${memory.importance}] ${memory.content}`)
    .join("\n")
    .slice(0, memorySettings.longTerm.maxContextChars);
  const learningRecords = listLearningRecords(workspaceRoot, 12);
  const learningText = learningRecords
    .map((record) => `- [${record.category}] ${record.title}: ${record.insight}`)
    .join("\n")
    .slice(0, 7000);
  const skills = prompt || requestedSkillNames.length > 0
    ? await activateSkills(prompt, projectPath, 3, requestedSkillNames)
    : [];
  const skillText = skills.map((skill) => [
    `Skill $${skill.name}: ${skill.description}`,
    skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
    skill.content
  ].filter(Boolean).join("\n")).join("\n\n").slice(0, 16000);
  const sections = [
    agentsMd ? `AGENTS.md guidance:\n${agentsMd}` : "",
    rules ? `.agent/rules guidance:\n${rules}` : "",
    memoryText ? `Project memory:\n${memoryText}` : "",
    learningText ? `Verified learning records:\n${learningText}` : "",
    skillText ? `Activated skills:\n${skillText}` : ""
  ].filter(Boolean);
  return {
    content: sections.join("\n\n"),
    activeSkills: skills.map((skill) => skill.name)
  };
}

export async function buildProjectContext(projectPath?: string, prompt = "", requestedSkillNames: string[] = []) {
  return (await buildProjectContextBundle(projectPath, prompt, requestedSkillNames)).content;
}

export function estimateMessageTokens(message: AgentMessage): number {
  const toolCallChars = message.toolCalls
    ? message.toolCalls.reduce((total, toolCall) => total + toolCall.name.length + JSON.stringify(toolCall.arguments).length, 0)
    : 0;
  const attachmentTokens = message.attachments?.reduce((total, attachment) => {
    if (attachment.text !== undefined) return total + estimateTokens(attachment.text);
    return total + (attachment.kind === "image" ? 850 : 1_200);
  }, 0) ?? 0;
  const reasoningChars = message.reasoningContent?.length ?? 0;
  const reasoningDetailChars = message.reasoningDetails ? JSON.stringify(message.reasoningDetails).length : 0;
  const charsTotal = message.content.length + toolCallChars + reasoningChars + reasoningDetailChars;
  return Math.max(1, Math.ceil(charsTotal / BYTES_PER_TOKEN) + attachmentTokens + 8);
}

function groupConversationTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns.filter((turn) => turn.length > 0);
}

function summarizeMessages(messages: AgentMessage[], summaryTokenLimit: number): string {
  const lines: string[] = [];
  for (const raw of messages) {
    const message = prepareForSummarization(raw);
    const normalized = message.content.replace(/\s+/g, " ").trim();
    const toolNames = message.toolCalls?.map((toolCall) => toolCall.name).join(", ");
    if (!normalized && !toolNames) continue;
    const label = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool result" : "System";
    const detail = normalized.slice(0, message.role === "tool" ? 180 : 360);
    lines.push(`- ${label}: ${detail}${normalized.length > detail.length ? "…" : ""}${toolNames ? ` [tools: ${toolNames}]` : ""}`);
  }
  const header = "Earlier conversation summary (chronological, generated locally):";
  const summary = `${header}\n${lines.join("\n")}`;
  return summary.slice(0, summaryTokenLimit * BYTES_PER_TOKEN);
}

export interface CompactOptions {
  enabled?: boolean;
  summaryTokenLimit?: number;
  toolOutputTokenLimit?: number; // 兼容旧调用,deprecated:使用 pruning 配置
  /**
   * 压缩模式。默认 summary(保持现状)。
   * transcript: 在摘要末尾追加 transcript 路径提示
   * segments:   写 segment_NNN.md + INDEX.md,并在摘要末尾追加回查提示
   */
  mode?: CompactionMode;
  /** segments 模式的渲染细节级别。 */
  detail?: CompactionDetail;
  /** 三段式工具结果修剪配置。缺省使用 defaultToolResultPruningConfig。 */
  pruning?: ToolResultPruningConfig;
  /** 工作区根路径,segments 模式必须提供以确定 segment 文件落盘位置。 */
  workspaceRoot?: string;
  /**
   * 当前是第几次压缩(用于 segment 编号)。
   * 缺省时根据 workspaceRoot/.agent/compaction 已有的 segment 文件数推断。
   */
  segmentIndex?: number;
}

/**
 * Compacts at turn boundaries so assistant tool calls stay paired with their
 * tool results. Recent turns are preserved verbatim (after toolResultPruning),
 * while older intent and decisions remain available as a summary.
 *
 * 相对旧版的改动:
 * - 摘要前自动剥离 system tags / reasoning / image(节省 token、避免签名校验失败)
 * - keep 的消息应用三段式 pruning 而非一刀切截断
 * - 末尾 dangling tool_call 会被丢弃,避免严格后端 400
 * - 支持 transcript / segments 模式把被省略内容落盘,让模型可自行回查
 */
export function compactMessagesWithSnapshot(
  messages: AgentMessage[],
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS,
  options: CompactOptions = {}
): CompactedContext {
  const summaryTokenLimit = Math.max(0, options.summaryTokenLimit ?? 1_600);
  const mode: CompactionMode = options.mode ?? "summary";
  const detail: CompactionDetail = options.detail ?? "balanced";
  const pruning = options.pruning ?? defaultToolResultPruningConfig;

  // 1) 先对保留区做三段式修剪,替代旧的 truncateToolMessage 一刀切。
  const pruned = pruneToolResults(messages, pruning);

  // 2) 按轮次分组,从最新往回装,直到装满预算。
  const turns = groupConversationTurns(pruned);
  const keptTurns: AgentMessage[][] = [];
  let keptTokens = 0;
  const recentBudget = Math.max(1_000, budgetTokens - (options.enabled === false ? 0 : summaryTokenLimit));

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const turnTokens = turn.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if (keptTurns.length > 0 && keptTokens + turnTokens > recentBudget) break;
    keptTurns.unshift(turn);
    keptTokens += turnTokens;
  }

  const kept = keptTurns.flat();
  const omittedCount = Math.max(0, pruned.length - kept.length);
  const omitted = pruned.slice(0, omittedCount);

  // 3) 生成摘要。摘要前已剥离 system tags / reasoning / image。
  let summaryText = omitted.length > 0 && options.enabled !== false
    ? summarizeMessages(omitted, summaryTokenLimit)
    : "";

  // 4) segments 模式:异步写盘由调用方触发(compactMessagesWithSegments),
  //    这里仅生成提示文本,不执行 I/O 以保持函数同步。
  if (summaryText && mode !== "summary" && options.workspaceRoot) {
    const location = path.join(options.workspaceRoot, COMPACTION_DIR);
    summaryText += buildTranscriptHint(mode, location);
  }

  const summaryMessage: AgentMessage | undefined = summaryText
    ? { role: "system", content: summaryText }
    : undefined;

  // 5) 组装并丢弃 dangling tool_call 尾部。
  const assembled = summaryMessage ? [summaryMessage, ...kept] : kept;
  const compacted = truncateTrailingIncompleteToolCall(assembled);

  const estimatedTokens = compacted.reduce((total, message) => total + estimateMessageTokens(message), 0);

  return {
    messages: compacted,
    snapshot: {
      budgetTokens,
      estimatedTokens,
      messageCount: messages.length,
      includedMessageCount: compacted.length - (summaryMessage ? 1 : 0),
      compactedMessageCount: omittedCount
    }
  };
}

/**
 * 异步版本:在 compactMessagesWithSnapshot 基础上,如果 mode=segments 且
 * 有 workspaceRoot,会把被省略的消息渲染成 segment_NNN.md 并追加 INDEX.md。
 *
 * 用法:替代原来的同步 compactMessagesWithSnapshot,仅当你希望启用 segments
 * 持久化时才调用;否则继续用同步版本即可。
 */
export async function compactMessagesWithSegments(
  messages: AgentMessage[],
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS,
  options: CompactOptions = {}
): Promise<CompactedContext> {
  const result = compactMessagesWithSnapshot(messages, budgetTokens, options);
  if (options.mode !== "segments" || !options.workspaceRoot) return result;
  if (result.snapshot.compactedMessageCount === 0) return result;

  const omittedCount = result.snapshot.compactedMessageCount;
  const omitted = messages.slice(0, omittedCount);
  if (omitted.length === 0) return result;

  const segmentIndex = options.segmentIndex ?? Date.now();
  try {
    await writeSegment(options.workspaceRoot, segmentIndex, omitted, options.detail ?? "balanced");
  } catch (error) {
    // 段落写盘失败不影响主流程,只记日志。
    console.warn("[contextManager] writeSegment failed:", error);
  }
  return result;
}

export function compactMessagesForContext(messages: AgentMessage[], maxChars = 64_000): AgentMessage[] {
  return compactMessagesWithSnapshot(messages, Math.max(1_000, Math.floor(maxChars / BYTES_PER_TOKEN))).messages;
}
