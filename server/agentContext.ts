import { getDeliveryWorkflowProfile, formatDeliveryWorkflowProfile } from "./deliveryWorkflow";
import { findAgentSkillHints, formatAgentSkillHints } from "./agentSkillHints";
import type { AgentMessage } from "./types";

export interface AgentContextBudget {
  maxMessages: number;
  maxTotalChars: number;
  maxToolResultChars: number;
  maxAssistantChars: number;
  keepRecentMessages: number;
}

export interface AgentContextOptions {
  projectPath?: string;
  thinkingMode?: string;
  budget?: Partial<AgentContextBudget>;
}

export interface AgentContextStats {
  originalMessages: number;
  finalMessages: number;
  originalChars: number;
  finalChars: number;
  trimmedMessages: number;
  matchedSkills: string[];
  deliveryIntent: string;
}

export interface PreparedAgentContext {
  messages: AgentMessage[];
  systemAddendum: string;
  stats: AgentContextStats;
}

const defaultBudget: AgentContextBudget = {
  maxMessages: 32,
  maxTotalChars: 42000,
  maxToolResultChars: 6000,
  maxAssistantChars: 9000,
  keepRecentMessages: 18
};

function countChars(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function truncateMiddle(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  const headLength = Math.max(0, Math.floor(maxChars * 0.65));
  const tailLength = Math.max(0, maxChars - headLength - 120);
  return [
    value.slice(0, headLength),
    `\n\n...[trimmed ${value.length - headLength - tailLength} chars for context budget]...\n\n`,
    tailLength > 0 ? value.slice(-tailLength) : ""
  ].join("");
}

function compactMessage(message: AgentMessage, budget: AgentContextBudget): AgentMessage {
  if (message.role === "tool") {
    return { ...message, content: truncateMiddle(message.content, budget.maxToolResultChars) };
  }

  if (message.role === "assistant") {
    return { ...message, content: truncateMiddle(message.content, budget.maxAssistantChars) };
  }

  return message;
}

function findLastUserPrompt(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) return message.content;
  }
  return "";
}

function summarizeOlderMessages(messages: AgentMessage[]) {
  const turns = messages.map((message, index) => {
    const label = message.role === "tool" ? `tool:${message.toolCallId ?? "unknown"}` : message.role;
    return `${index + 1}. ${label}: ${truncateMiddle(message.content.replace(/\s+/g, " ").trim(), 600)}`;
  });

  return [
    "Earlier conversation was compacted to keep the agent focused and within context budget.",
    "Use this summary for continuity, but prefer the latest user request and recent tool results.",
    "",
    ...turns
  ].join("\n");
}

function buildSystemAddendum(input: {
  projectPath?: string;
  thinkingMode?: string;
  skillHints: string;
  matchedSkillIds: string[];
  deliveryWorkflow: string;
}) {
  return [
    "## Rcode Agent Context Policy",
    "Rcode is a delivery-first local coding agent comparable to Codex and other mainstream coding agents.",
    input.projectPath
      ? `Current project root: ${input.projectPath}. Prefer project-scoped reads, edits, checks, git status, git diff, and PR actions.`
      : "No concrete project root was provided. Avoid assuming a real workspace path.",
    input.thinkingMode ? `Thinking mode requested by user interface: ${input.thinkingMode}.` : undefined,
    "Default behavior: directly deliver working code, bug fixes, tests, and PR-ready summaries instead of only explaining.",
    "For feature work: inspect relevant files, implement the change, review diff, run validation when available, then summarize.",
    "For bug fixes: identify root cause, make the smallest safe fix, run targeted validation, then explain root cause and result.",
    "For PR work: read git_status and git_diff, include Summary / Tests / Risks in the PR body, then use open_pull_request only when requested.",
    "Use run_tests for validation instead of generic run_shell when possible.",
    "Keep answers grounded in the available project context and tool results.",
    "When context is compacted, treat the compacted summary as lower confidence than recent messages.",
    "Prefer small, reversible changes and explain the changed files after edits.",
    input.matchedSkillIds.length > 0 ? `Matched skills: ${input.matchedSkillIds.join(", ")}.` : "Matched skills: none.",
    `\n## Delivery Workflow\n${input.deliveryWorkflow}`,
    input.skillHints ? `\n## Active Skill Hints\n${input.skillHints}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function prepareAgentContext(
  messages: AgentMessage[],
  options: AgentContextOptions = {}
): PreparedAgentContext {
  const budget: AgentContextBudget = { ...defaultBudget, ...options.budget };
  const originalChars = countChars(messages);
  const latestPrompt = findLastUserPrompt(messages);
  const matchedSkills = findAgentSkillHints(latestPrompt, 8);
  const matchedSkillIds = matchedSkills.map((skill) => skill.id);
  const skillHints = formatAgentSkillHints(matchedSkills);
  const deliveryProfile = getDeliveryWorkflowProfile(latestPrompt);
  const deliveryWorkflow = formatDeliveryWorkflowProfile(deliveryProfile);

  let compacted = messages.map((message) => compactMessage(message, budget));

  const shouldSummarize = compacted.length > budget.maxMessages || countChars(compacted) > budget.maxTotalChars;
  if (shouldSummarize) {
    const keepCount = Math.min(budget.keepRecentMessages, compacted.length);
    const older = compacted.slice(0, Math.max(0, compacted.length - keepCount));
    const recent = compacted.slice(-keepCount);
    const summary: AgentMessage = {
      role: "system",
      content: summarizeOlderMessages(older)
    };
    compacted = older.length > 0 ? [summary, ...recent] : recent;
  }

  while (compacted.length > budget.maxMessages) {
    compacted.splice(1, 1);
  }

  while (countChars(compacted) > budget.maxTotalChars && compacted.length > 6) {
    compacted.splice(1, 1);
  }

  const systemAddendum = buildSystemAddendum({
    projectPath: options.projectPath,
    thinkingMode: options.thinkingMode,
    skillHints,
    matchedSkillIds,
    deliveryWorkflow
  });

  const contextMessage: AgentMessage = {
    role: "system",
    content: systemAddendum
  };

  const finalMessages = [contextMessage, ...compacted];

  return {
    messages: finalMessages,
    systemAddendum,
    stats: {
      originalMessages: messages.length,
      finalMessages: finalMessages.length,
      originalChars,
      finalChars: countChars(finalMessages),
      trimmedMessages: Math.max(0, messages.length - compacted.length),
      matchedSkills: matchedSkillIds,
      deliveryIntent: deliveryProfile.intent
    }
  };
}

export function getDefaultAgentContextBudget() {
  return { ...defaultBudget };
}
