import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { listLearningRecords, listMemories } from "../storage/database";
import { getWorkspaceRoot } from "../security/sandbox";
import { activateSkills } from "./skills";
import type { AgentMessage, ContextSnapshot } from "../shared/types";

const DEFAULT_CONTEXT_BUDGET_TOKENS = 16_000;
const TOOL_OUTPUT_TOKEN_LIMIT = 900;
const SUMMARY_TOKEN_LIMIT = 1_600;

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

export async function buildProjectContextBundle(projectPath?: string, prompt = ""): Promise<ProjectContextBundle> {
  const workspaceRoot = getWorkspaceRoot(projectPath);
  const agentsMd = await readIfExists(path.join(workspaceRoot, "AGENTS.md"), 8000);
  const rules = await readRuleFiles(workspaceRoot);
  const memories = listMemories(workspaceRoot, 12) as Array<{ kind: string; content: string }>;
  const memoryText = memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n").slice(0, 6000);
  const learningRecords = listLearningRecords(workspaceRoot, 12);
  const learningText = learningRecords
    .map((record) => `- [${record.category}] ${record.title}: ${record.insight}`)
    .join("\n")
    .slice(0, 7000);
  const skills = prompt ? await activateSkills(prompt, projectPath) : [];
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

export async function buildProjectContext(projectPath?: string, prompt = "") {
  return (await buildProjectContextBundle(projectPath, prompt)).content;
}

export function estimateMessageTokens(message: AgentMessage): number {
  const toolCallChars = message.toolCalls
    ? message.toolCalls.reduce((total, toolCall) => total + toolCall.name.length + JSON.stringify(toolCall.arguments).length, 0)
    : 0;
  const attachmentTokens = message.attachments?.reduce((total, attachment) => {
    if (attachment.text !== undefined) return total + Math.ceil(attachment.text.length / 4);
    return total + (attachment.kind === "image" ? 850 : 1_200);
  }, 0) ?? 0;
  const reasoningChars = message.reasoningContent?.length ?? 0;
  const reasoningDetailChars = message.reasoningDetails ? JSON.stringify(message.reasoningDetails).length : 0;
  return Math.max(1, Math.ceil((message.content.length + toolCallChars + reasoningChars + reasoningDetailChars) / 4) + attachmentTokens + 8);
}

function truncateToolMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "tool") return message;
  const tokenEstimate = estimateMessageTokens(message);
  if (tokenEstimate <= TOOL_OUTPUT_TOKEN_LIMIT) return message;
  const maxChars = TOOL_OUTPUT_TOKEN_LIMIT * 4;
  const headChars = Math.floor(maxChars * 0.72);
  const tailChars = Math.floor(maxChars * 0.2);
  return {
    ...message,
    content: `${message.content.slice(0, headChars)}\n\n[... tool output compacted; full output is available in artifacts/audit ...]\n\n${message.content.slice(-tailChars)}`
  };
}

function groupConversationTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(truncateToolMessage(message));
  }
  return turns.filter((turn) => turn.length > 0);
}

function summarizeMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const normalized = message.content.replace(/\s+/g, " ").trim();
    const toolNames = message.toolCalls?.map((toolCall) => toolCall.name).join(", ");
    if (!normalized && !toolNames) continue;
    const label = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool result" : "System";
    const detail = normalized.slice(0, message.role === "tool" ? 180 : 360);
    lines.push(`- ${label}: ${detail}${normalized.length > detail.length ? "…" : ""}${toolNames ? ` [tools: ${toolNames}]` : ""}`);
  }
  const header = "Earlier conversation summary (chronological, generated locally):";
  const summary = `${header}\n${lines.join("\n")}`;
  return summary.slice(0, SUMMARY_TOKEN_LIMIT * 4);
}

/**
 * Compacts at turn boundaries so assistant tool calls stay paired with their
 * tool results. Recent turns are preserved verbatim (apart from large tool
 * output), while older intent and decisions remain available as a summary.
 */
export function compactMessagesWithSnapshot(
  messages: AgentMessage[],
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS
): CompactedContext {
  const turns = groupConversationTurns(messages);
  const keptTurns: AgentMessage[][] = [];
  let keptTokens = 0;
  const recentBudget = Math.max(1_000, budgetTokens - SUMMARY_TOKEN_LIMIT);

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const turnTokens = turn.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if (keptTurns.length > 0 && keptTokens + turnTokens > recentBudget) break;
    keptTurns.unshift(turn);
    keptTokens += turnTokens;
  }

  const kept = keptTurns.flat();
  const omittedCount = Math.max(0, messages.length - kept.length);
  const omitted = messages.slice(0, omittedCount);
  const summaryMessage: AgentMessage | undefined = omitted.length > 0
    ? { role: "system", content: summarizeMessages(omitted) }
    : undefined;
  const compacted = summaryMessage ? [summaryMessage, ...kept] : kept;
  const estimatedTokens = compacted.reduce((total, message) => total + estimateMessageTokens(message), 0);

  return {
    messages: compacted,
    snapshot: {
      budgetTokens,
      estimatedTokens,
      messageCount: messages.length,
      includedMessageCount: kept.length,
      compactedMessageCount: omittedCount
    }
  };
}

export function compactMessagesForContext(messages: AgentMessage[], maxChars = 64_000): AgentMessage[] {
  return compactMessagesWithSnapshot(messages, Math.max(1_000, Math.floor(maxChars / 4))).messages;
}
