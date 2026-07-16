import { nanoid } from "nanoid";
import { extractLearningCandidates, type LearningCandidate, type LearningExtractionResult } from "../providers/aiProvider";
import { hasBillableProviderUsage, normalizeProviderUsage } from "../providers/providerUsage";
import { getWorkspaceRoot } from "../security/sandbox";
import type { AgentMessage } from "../shared/types";
import {
  recordAgentUsageEvent,
  recordAuditEvent,
  recordLearningRun,
  saveLearningRecord,
  type LearningRecord,
  type LearningRun
} from "../storage/database";

const preferenceCue = /(?:\b(?:remember|prefer|always|never)\b|记住|偏好|以后(?:都|请)|始终|不要再)/iu;

function redactSensitiveText(value: string) {
  return value
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(api[_ -]?key|authorization|password|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[a-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
}

function latestUserTurnIndex(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && !message.content.startsWith("Visual result returned by tool ")) return index;
  }
  return -1;
}

export function evaluateLearningTurn(messages: AgentMessage[]) {
  const startIndex = latestUserTurnIndex(messages);
  if (startIndex < 0) return { eligible: false, reason: "本轮没有用户任务。", startIndex, toolNames: [] as string[] };
  const turn = messages.slice(startIndex);
  const toolNames = turn.flatMap((message) => message.toolCalls?.map((call) => call.name) ?? []);
  if (toolNames.includes("record_learning")) {
    return { eligible: false, reason: "本轮已经由代理显式保存学习记录。", startIndex, toolNames };
  }
  const userPrompt = messages[startIndex].content;
  const hasTaskEvidence = toolNames.length > 0 || preferenceCue.test(userPrompt);
  if (!hasTaskEvidence) {
    return { eligible: false, reason: "本轮没有工具验证或明确的长期偏好。", startIndex, toolNames };
  }
  return { eligible: true, reason: "本轮具备可供学习阶段核验的任务证据。", startIndex, toolNames };
}

export function buildLearningTranscript(messages: AgentMessage[], startIndex = latestUserTurnIndex(messages)) {
  if (startIndex < 0) return "";
  const turn = messages.slice(startIndex);
  const toolNamesById = new Map<string, string>();
  for (const message of turn) {
    for (const call of message.toolCalls ?? []) toolNamesById.set(call.id, call.name);
  }

  const lines: string[] = [];
  for (const message of turn) {
    if (message.role === "user" && message.content.startsWith("Visual result returned by tool ")) continue;
    if (message.role === "user") {
      lines.push(`USER REQUEST: ${redactSensitiveText(message.content).slice(0, 2_500)}`);
      continue;
    }
    if (message.role === "assistant") {
      const content = redactSensitiveText(message.content).trim();
      if (content) lines.push(`ASSISTANT: ${content.slice(0, 1_500)}`);
      for (const call of message.toolCalls ?? []) {
        const args = redactSensitiveText(JSON.stringify(call.arguments));
        lines.push(`TOOL CALL ${call.name}: ${args.slice(0, 700)}`);
      }
      continue;
    }
    if (message.role === "tool") {
      const name = message.toolCallId ? toolNamesById.get(message.toolCallId) : undefined;
      lines.push(`TOOL RESULT ${name ?? "unknown"}: ${redactSensitiveText(message.content).slice(0, 1_000)}`);
    }
  }
  return lines.join("\n").slice(0, 12_000);
}

interface AutoLearningDependencies {
  extract: (transcript: string, options: { model?: string; projectPath?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<LearningExtractionResult>;
  save: (input: Parameters<typeof saveLearningRecord>[0]) => LearningRecord;
  saveRun: (input: Parameters<typeof recordLearningRun>[0]) => LearningRun;
  audit: typeof recordAuditEvent;
  usage: typeof recordAgentUsageEvent;
}

const defaultDependencies: AutoLearningDependencies = {
  extract: extractLearningCandidates,
  save: saveLearningRecord,
  saveRun: recordLearningRun,
  audit: recordAuditEvent,
  usage: recordAgentUsageEvent
};

export async function runAutoLearning(input: {
  messages: AgentMessage[];
  projectPath?: string;
  conversationId: string;
  requestId?: string;
  model?: string;
  signal?: AbortSignal;
}, dependencies: AutoLearningDependencies = defaultDependencies): Promise<{ run: LearningRun; records: LearningRecord[] }> {
  const requestedProjectPath = input.projectPath?.trim();
  if (!requestedProjectPath) {
    return {
      run: {
        id: "",
        projectPath: "",
        conversationId: input.conversationId,
        status: "skipped",
        reason: "临时会话没有项目作用域，不保存项目学习记录。",
        recordsSaved: 0,
        createdAt: new Date().toISOString()
      },
      records: []
    };
  }
  const projectPath = getWorkspaceRoot(requestedProjectPath);

  const evaluation = evaluateLearningTurn(input.messages);
  if (!evaluation.eligible) {
    const run = dependencies.saveRun({
      projectPath,
      conversationId: input.conversationId,
      status: "skipped",
      reason: evaluation.reason
    });
    return { run, records: [] };
  }

  try {
    const extraction = await dependencies.extract(buildLearningTranscript(input.messages, evaluation.startIndex), {
      model: input.model,
      projectPath,
      signal: input.signal,
      timeoutMs: 20_000
    });
    if (extraction.usage) {
      const providerUsage = normalizeProviderUsage(extraction.usage);
      if (hasBillableProviderUsage(providerUsage)) {
        dependencies.usage({
          eventType: "ai_call",
          projectPath,
          conversationId: input.conversationId,
          requestId: input.requestId,
          model: extraction.model,
          provider: extraction.provider,
          promptTokens: providerUsage.inputTokens,
          completionTokens: providerUsage.outputTokens,
          totalTokens: providerUsage.totalTokens,
          cachedTokens: providerUsage.cacheReadTokens,
          cacheReadTokens: providerUsage.cacheReadTokens,
          cacheCreationTokens: providerUsage.cacheCreationTokens
        });
      }
    }

    if (extraction.records.length === 0) {
      const run = dependencies.saveRun({
        projectPath,
        conversationId: input.conversationId,
        status: "no_candidate",
        reason: "已完成独立核验，但没有发现同时满足可复用、已验证和安全要求的经验。"
      });
      return { run, records: [] };
    }

    const records: LearningRecord[] = [];
    const rejected: string[] = [];
    for (const candidate of extraction.records) {
      try {
        const record = dependencies.save({
          projectPath,
          conversationId: input.conversationId,
          title: candidate.title,
          insight: candidate.insight,
          category: candidate.category,
          evidence: candidate.evidence,
          importance: candidate.importance,
          dedupeKey: candidate.dedupeKey,
          source: "automatic",
          confidence: candidate.confidence
        });
        records.push(record);
        dependencies.audit({
          projectPath,
          conversationId: input.conversationId,
          toolCallId: `auto_learning_${nanoid()}`,
          toolName: "record_learning",
          permissionEffect: "allow",
          permissionReason: "Completion-stage automatic learning verifier.",
          ok: true,
          input: { title: record.title, category: record.category, dedupeKey: record.dedupeKey },
          outputSummary: `Automatic learning recorded: ${record.title}`
        });
      } catch (error) {
        rejected.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (records.length === 0) {
      const run = dependencies.saveRun({
        projectPath,
        conversationId: input.conversationId,
        status: "failed",
        reason: `提取结果未通过本地安全或格式校验：${rejected[0] ?? "未知错误"}`
      });
      return { run, records: [] };
    }

    const run = dependencies.saveRun({
      projectPath,
      conversationId: input.conversationId,
      status: "saved",
      reason: rejected.length > 0 ? `保存 ${records.length} 条，另有 ${rejected.length} 条未通过本地校验。` : `已保存 ${records.length} 条经过验证的可复用经验。`,
      recordsSaved: records.length
    });
    return { run, records };
  } catch (error) {
    const reason = redactSensitiveText(error instanceof Error ? error.message : String(error));
    const run = dependencies.saveRun({
      projectPath,
      conversationId: input.conversationId,
      status: "failed",
      reason: `自动学习提取失败，但不影响任务结果：${reason}`
    });
    return { run, records: [] };
  }
}

export type { LearningCandidate };
