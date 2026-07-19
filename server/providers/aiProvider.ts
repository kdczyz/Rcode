import { getToolDefinitions } from "../runtime/tools";
import type { AgentMessage, AppliedReasoningConfig, ContextSnapshot, PermissionMode, ReasoningDialect, ThinkingMode, ToolCall, ToolResult, AgentToolName, ToolRisk } from "../shared/types";
import { getRuntimeConfig } from "../runtime/config";
import { nanoid } from "nanoid";
import { buildProjectContextBundle, compactMessagesWithSnapshot } from "../agent/contextManager";
import type { ProviderUsagePayload } from "./providerUsage";
import { resolveAiProviderForExecution } from "./aiProviderRegistry";

interface ChatChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning_details?: Array<Record<string, unknown>> | null;
    tool_calls?: Array<{
      id: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: AiUsage;
}

interface StreamDelta {
  content?: string;
  reasoning_content?: string;
  reasoning_details?: Array<Record<string, unknown>>;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface StreamChunk {
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: AiUsage;
}

export interface AiTurn {
  content: string;
  toolCalls: ToolCall[];
  reasoningContent?: string;
  reasoningDetails?: Array<Record<string, unknown>>;
}

export type AiUsage = ProviderUsagePayload;

export interface ApprovalAuditResult {
  allow: boolean;
  risk: ToolRisk;
  reason: string;
}

export type LearningCandidateCategory = "preference" | "project" | "pattern" | "bugfix" | "workflow";

export interface LearningCandidate {
  dedupeKey: string;
  title: string;
  insight: string;
  category: LearningCandidateCategory;
  evidence: string;
  importance: number;
  confidence: number;
}

export interface LearningExtractionResult {
  records: LearningCandidate[];
  usage?: AiUsage;
  model: string;
  provider: string;
}

export type { ThinkingMode } from "../shared/types";

interface ReasoningRequestConfig {
  parameters: Record<string, unknown>;
  omitParameters?: string[];
  replay: "none" | "tool_calls" | "all";
  replayField: "reasoning_content" | "reasoning_details";
  applied: AppliedReasoningConfig;
}

const unsupportedReasoningTargets = new Set<string>();

function reasoningTargetKey(baseUrl: string, model: string, dialect: ReasoningDialect = "auto") {
  return `${baseUrl.replace(/\/+$/, "").toLowerCase()}::${model.toLowerCase()}::${dialect}`;
}

function providerHostname(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function modeLabel(mode: ThinkingMode) {
  return mode === "fast" ? "快速" : mode === "deep" ? "深度" : "标准";
}

function reasoningConfig(
  mode: ThinkingMode,
  parameters: Record<string, unknown>,
  applied: Omit<AppliedReasoningConfig, "mode">,
  options: Pick<ReasoningRequestConfig, "replay" | "replayField" | "omitParameters"> = { replay: "none", replayField: "reasoning_content" }
): ReasoningRequestConfig {
  return { parameters, applied: { mode, transport: "direct", ...applied }, replay: options.replay, replayField: options.replayField, omitParameters: options.omitParameters };
}

function throughGateway(config: ReasoningRequestConfig): ReasoningRequestConfig {
  return {
    ...config,
    applied: {
      ...config.applied,
      transport: "gateway",
      label: `${modeLabel(config.applied.mode)} · 中转 ${config.applied.value}`
    }
  };
}

function promptOnlyConfig(mode: ThinkingMode): ReasoningRequestConfig {
  return reasoningConfig(mode, {}, {
    native: false,
    method: "prompt_fallback",
    value: "system_prompt",
    label: `${modeLabel(mode)} · 提示兼容`,
    transport: "fallback"
  });
}

function isGlm52OrNewer(model: string) {
  const match = model.toLowerCase().match(/^glm-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}

/** Maps native endpoints and multi-model gateways to the reasoning controls their upstream accepts. */
export function buildReasoningRequestConfig(
  baseUrl: string,
  model: string,
  mode: ThinkingMode = "balanced",
  dialect: ReasoningDialect = "auto"
): ReasoningRequestConfig {
  const targetKey = reasoningTargetKey(baseUrl, model, dialect);
  if (unsupportedReasoningTargets.has(targetKey)) return promptOnlyConfig(mode);

  const hostname = providerHostname(baseUrl);
  const normalizedModel = model.toLowerCase();
  const modelId = normalizedModel.split("/").pop() ?? normalizedModel;
  const isOfficialMiMo = hostname === "api.xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com");
  const isOfficialDeepSeek = hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
  const isOfficialZhipu = hostname === "open.bigmodel.cn" || hostname.endsWith(".bigmodel.cn") || hostname === "api.z.ai" || hostname.endsWith(".z.ai");
  const isOfficialMiniMax = hostname === "api.minimaxi.com" || hostname.endsWith(".minimaxi.com") || hostname === "api.minimax.io" || hostname.endsWith(".minimax.io");
  const isOfficialKimi = hostname === "api.moonshot.cn" || hostname.endsWith(".moonshot.cn") || hostname === "api.moonshot.ai" || hostname.endsWith(".moonshot.ai");
  const isDashScope = hostname.endsWith(".dashscope.aliyuncs.com") || hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".maas.aliyuncs.com");
  const isOpenRouter = hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  const isKnownSub2Api = hostname === "sub2api.org" || hostname.endsWith(".sub2api.org") || hostname === "pincc.ai" || hostname.endsWith(".pincc.ai");
  const isSub2Api = dialect === "sub2api" || (dialect === "auto" && isKnownSub2Api);
  const forceGenericOpenAi = dialect === "openai-compatible";
  const platformOwnsReasoning = isDashScope || isOpenRouter || forceGenericOpenAi;

  const isMiMo = !platformOwnsReasoning && (isOfficialMiMo || /^mimo[-_.]/i.test(modelId));
  const isDeepSeek = !platformOwnsReasoning && (isOfficialDeepSeek || /^deepseek[-_.]/i.test(modelId));
  const isZhipu = !platformOwnsReasoning && (isOfficialZhipu || /^glm[-_.]/i.test(modelId));
  const isMiniMax = !platformOwnsReasoning && (isOfficialMiniMax || /^minimax[-_.]/i.test(modelId));
  const isKimi = !platformOwnsReasoning && (isOfficialKimi || /^(?:kimi|moonshot)[-_.]/i.test(modelId));
  const isQwenViaSub2Api = isSub2Api && /^qwen(?:\d+)?[-_.]/i.test(modelId);
  const translated = (config: ReasoningRequestConfig, officialEndpoint: boolean) =>
    isSub2Api || !officialEndpoint ? throughGateway(config) : config;

  if (isOpenRouter && !forceGenericOpenAi) {
    const effort = mode === "fast" ? "low" : mode === "deep" ? "high" : "medium";
    return throughGateway(reasoningConfig(mode, { reasoning: { effort, exclude: false } }, {
      native: true, method: "reasoning_effort", value: effort, label: `${modeLabel(mode)} · 原生 ${effort}`
    }));
  }

  if (isMiMo) {
    const value = mode === "fast" ? "disabled" : "enabled";
    return translated(reasoningConfig(mode, { thinking: { type: value } }, {
      native: true, method: "thinking_toggle", value, label: `${modeLabel(mode)} · 原生思考${value === "enabled" ? "开启" : "关闭"}`
    }, { replay: value === "enabled" ? "tool_calls" : "none", replayField: "reasoning_content" }), isOfficialMiMo);
  }

  if (isDeepSeek) {
    if (mode === "fast") {
      return translated(reasoningConfig(mode, { thinking: { type: "disabled" } }, {
        native: true, method: "thinking_toggle", value: "disabled", label: "快速 · 原生思考关闭"
      }), isOfficialDeepSeek);
    }
    const effort = mode === "deep" ? "max" : "high";
    return translated(reasoningConfig(mode, { thinking: { type: "enabled" }, reasoning_effort: effort }, {
      native: true, method: "reasoning_effort", value: effort, label: `${modeLabel(mode)} · 原生 ${effort}`
    }, { replay: "tool_calls", replayField: "reasoning_content" }), isOfficialDeepSeek);
  }

  if (isZhipu) {
    if (mode === "fast") {
      return translated(reasoningConfig(mode, { thinking: { type: "disabled" } }, {
        native: true, method: "thinking_toggle", value: "disabled", label: "快速 · 原生思考关闭"
      }), isOfficialZhipu);
    }
    if (isGlm52OrNewer(normalizedModel)) {
      const effort = mode === "deep" ? "max" : "medium";
      return translated(reasoningConfig(mode, { thinking: { type: "enabled", ...(mode === "deep" ? { clear_thinking: false } : {}) }, reasoning_effort: effort }, {
        native: true, method: "reasoning_effort", value: effort, label: `${modeLabel(mode)} · 原生 ${effort}`
      }, { replay: mode === "deep" ? "all" : "tool_calls", replayField: "reasoning_content" }), isOfficialZhipu);
    }
    return translated(reasoningConfig(mode, { thinking: { type: "enabled", ...(mode === "deep" ? { clear_thinking: false } : {}) } }, {
      native: true, method: "thinking_toggle", value: "enabled", label: `${modeLabel(mode)} · 原生思考开启`
    }, { replay: mode === "deep" ? "all" : "tool_calls", replayField: "reasoning_content" }), isOfficialZhipu);
  }

  if (isKimi) {
    const omitTemperature = ["temperature"];
    if (/kimi-k3/i.test(normalizedModel)) {
      return translated(reasoningConfig(mode, { reasoning_effort: "max" }, {
        native: true, method: "always_on", value: "max", label: `${modeLabel(mode)} · 模型固定 max`
      }, { replay: "all", replayField: "reasoning_content", omitParameters: omitTemperature }), isOfficialKimi);
    }
    if (/kimi-k2\.7-code/i.test(normalizedModel)) {
      return translated(reasoningConfig(mode, {}, {
        native: true, method: "always_on", value: "forced", label: `${modeLabel(mode)} · 模型固定思考`
      }, { replay: "all", replayField: "reasoning_content", omitParameters: omitTemperature }), isOfficialKimi);
    }
    if (/kimi-k2\.(?:6|5)/i.test(normalizedModel)) {
      const value = mode === "fast" ? "disabled" : "enabled";
      const thinking = { type: value, ...(mode === "deep" && /kimi-k2\.6/i.test(normalizedModel) ? { keep: "all" } : {}) };
      return translated(reasoningConfig(mode, { thinking }, {
        native: true, method: "thinking_toggle", value, label: `${modeLabel(mode)} · 原生思考${value === "enabled" ? "开启" : "关闭"}`
      }, { replay: mode === "deep" && /kimi-k2\.6/i.test(normalizedModel) ? "all" : value === "enabled" ? "tool_calls" : "none", replayField: "reasoning_content", omitParameters: omitTemperature }), isOfficialKimi);
    }
    if (/thinking/i.test(normalizedModel)) {
      return translated(reasoningConfig(mode, {}, {
        native: true, method: "always_on", value: "forced", label: `${modeLabel(mode)} · 模型固定思考`
      }, { replay: "tool_calls", replayField: "reasoning_content", omitParameters: omitTemperature }), isOfficialKimi);
    }
    return promptOnlyConfig(mode);
  }

  if (isMiniMax) {
    if (!isOfficialMiniMax) {
      const value = mode === "fast" ? "disabled" : "adaptive";
      return throughGateway(reasoningConfig(mode, { thinking: { type: value } }, {
        native: true, method: "thinking_toggle", value, label: `${modeLabel(mode)} · 原生 ${value}`
      }, { replay: value === "adaptive" ? "tool_calls" : "none", replayField: "reasoning_content" }));
    }
    return reasoningConfig(mode, { reasoning_split: true }, {
      native: true, method: "always_on", value: "reasoning_split", label: `${modeLabel(mode)} · 模型固定思考`
    }, { replay: "tool_calls", replayField: "reasoning_details" });
  }

  if (isQwenViaSub2Api) {
    const value = mode === "fast" ? "disabled" : "enabled";
    return throughGateway(reasoningConfig(mode, { thinking: { type: value } }, {
      native: true, method: "thinking_toggle", value, label: `${modeLabel(mode)} · 原生思考${value === "enabled" ? "开启" : "关闭"}`
    }, { replay: value === "enabled" ? "tool_calls" : "none", replayField: "reasoning_content" }));
  }

  if (isDashScope && !forceGenericOpenAi) {
    if (/minimax/i.test(normalizedModel)) {
      const value = mode === "fast" ? "disabled" : "adaptive";
      return reasoningConfig(mode, { thinking: { type: value } }, {
        native: true, method: "thinking_toggle", value, label: `${modeLabel(mode)} · 原生 ${value}`
      }, { replay: value === "adaptive" ? "tool_calls" : "none", replayField: "reasoning_content" });
    }
    if (/deepseek|glm/i.test(normalizedModel)) {
      if (mode === "fast") {
        return reasoningConfig(mode, { enable_thinking: false }, {
          native: true, method: "thinking_toggle", value: "disabled", label: "快速 · 原生思考关闭"
        });
      }
      const effort = mode === "deep" ? "max" : "high";
      return reasoningConfig(mode, { enable_thinking: true, reasoning_effort: effort }, {
        native: true, method: "reasoning_effort", value: effort, label: `${modeLabel(mode)} · 原生 ${effort}`
      }, { replay: "tool_calls", replayField: "reasoning_content" });
    }
    if (/qwen/i.test(normalizedModel)) {
      if (mode === "fast") {
        return reasoningConfig(mode, { enable_thinking: false }, {
          native: true, method: "thinking_toggle", value: "disabled", label: "快速 · 原生思考关闭"
        });
      }
      const budget = mode === "deep" ? 32_768 : 8_192;
      return reasoningConfig(mode, { enable_thinking: true, thinking_budget: budget, ...(mode === "deep" ? { preserve_thinking: true } : {}) }, {
        native: true, method: "reasoning_budget", value: String(budget), label: `${modeLabel(mode)} · 原生预算 ${Math.round(budget / 1024)}k`
      }, { replay: mode === "deep" ? "all" : "tool_calls", replayField: "reasoning_content" });
    }
    const enabled = mode !== "fast";
    return reasoningConfig(mode, { enable_thinking: enabled }, {
      native: true, method: "thinking_toggle", value: enabled ? "enabled" : "disabled", label: `${modeLabel(mode)} · 原生思考${enabled ? "开启" : "关闭"}`
    }, { replay: enabled ? "tool_calls" : "none", replayField: "reasoning_content" });
  }

  const effort = mode === "fast" ? "low" : mode === "deep" ? "high" : "medium";
  const generic = reasoningConfig(mode, { reasoning_effort: effort }, {
    native: true, method: "reasoning_effort", value: effort, label: `${modeLabel(mode)} · 原生 ${effort}`
  }, { replay: "none", replayField: "reasoning_content" });
  return isSub2Api ? throughGateway(generic) : generic;
}

function promptFallbackReasoningConfig(mode: ThinkingMode): AppliedReasoningConfig {
  return {
    mode,
    native: false,
    method: "prompt_fallback",
    value: "system_prompt",
    label: `${modeLabel(mode)} · 提示兼容`,
    transport: "fallback"
  };
}

const reasoningControlKeys = ["reasoning_effort", "thinking", "enable_thinking", "thinking_budget", "preserve_thinking", "reasoning_split", "reasoning"];

function removeUnsupportedReasoningControls(
  body: Record<string, unknown>,
  errorBody: string,
  targetKey: string
) {
  if (!/reasoning|thinking|effort/i.test(errorBody)) return false;
  let changed = false;
  const normalizedError = errorBody.toLowerCase();
  const mentionedKeys = reasoningControlKeys.filter((key) => normalizedError.includes(key));
  const keysToRemove = mentionedKeys.length > 0 ? mentionedKeys : reasoningControlKeys;
  for (const key of keysToRemove) {
    if (key in body) {
      delete body[key];
      changed = true;
    }
  }
  if (changed && !reasoningControlKeys.some((key) => key in body)) unsupportedReasoningTargets.add(targetKey);
  return changed;
}

function effectiveReasoningConfig(selected: ReasoningRequestConfig, body: Record<string, unknown>): AppliedReasoningConfig {
  const mode = selected.applied.mode;
  const finalize = (config: AppliedReasoningConfig): AppliedReasoningConfig => {
    if (!config.native || selected.applied.transport !== "gateway") {
      return { ...config, transport: config.native ? "direct" : "fallback" };
    }
    return {
      ...config,
      transport: "gateway",
      label: `${modeLabel(mode)} · 中转 ${config.value}`
    };
  };
  if (typeof body.reasoning_effort === "string") {
    return finalize({ mode, native: true, method: "reasoning_effort", value: body.reasoning_effort, label: `${modeLabel(mode)} · 原生 ${body.reasoning_effort}` });
  }
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  if (reasoning && typeof reasoning.effort === "string") {
    return finalize({ mode, native: true, method: "reasoning_effort", value: reasoning.effort, label: `${modeLabel(mode)} · 原生 ${reasoning.effort}` });
  }
  if (typeof body.thinking_budget === "number") {
    return finalize({ mode, native: true, method: "reasoning_budget", value: String(body.thinking_budget), label: `${modeLabel(mode)} · 原生预算 ${Math.round(body.thinking_budget / 1024)}k` });
  }
  const thinking = body.thinking as { type?: unknown } | undefined;
  if (thinking && typeof thinking.type === "string") {
    return finalize({ mode, native: true, method: "thinking_toggle", value: thinking.type, label: `${modeLabel(mode)} · 原生 ${thinking.type}` });
  }
  if (typeof body.enable_thinking === "boolean") {
    return finalize({ mode, native: true, method: "thinking_toggle", value: body.enable_thinking ? "enabled" : "disabled", label: `${modeLabel(mode)} · 原生思考${body.enable_thinking ? "开启" : "关闭"}` });
  }
  if (body.reasoning_split === true || selected.applied.method === "always_on") return selected.applied;
  return promptFallbackReasoningConfig(mode);
}

function appendReasoningText(current: string, incoming: string) {
  if (!incoming) return current;
  return incoming.startsWith(current) ? incoming : current + incoming;
}

function reasoningDetailsText(details: Array<Record<string, unknown>>) {
  return details.map((detail) => typeof detail.text === "string" ? detail.text : "").join("");
}

function mergeReasoningDetails(
  current: Array<Record<string, unknown>> | undefined,
  incoming: Array<Record<string, unknown>>
) {
  const merged = current?.map((detail) => ({ ...detail })) ?? [];
  for (const [position, detail] of incoming.entries()) {
    const detailIndex = typeof detail.index === "number" ? detail.index : undefined;
    const detailId = typeof detail.id === "string" ? detail.id : undefined;
    const existingIndex = merged.findIndex((candidate, candidatePosition) =>
      (detailIndex !== undefined && candidate.index === detailIndex) ||
      (detailId !== undefined && candidate.id === detailId) ||
      (detailIndex === undefined && detailId === undefined && candidatePosition === position)
    );
    if (existingIndex === -1) {
      merged.push({ ...detail });
      continue;
    }
    const existing = merged[existingIndex];
    const existingText = typeof existing.text === "string" ? existing.text : "";
    const incomingText = typeof detail.text === "string" ? detail.text : "";
    merged[existingIndex] = {
      ...existing,
      ...detail,
      ...(incomingText ? { text: appendReasoningText(existingText, incomingText) } : {})
    };
  }
  return merged;
}

const VALID_BUILTIN_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "list_files",
  "search_text",
  "inspect_tree",
  "apply_patch",
  "web_fetch",
  "run_shell",
  "git_status",
  "git_diff"
]);

function isToolName(value: string): value is AgentToolName {
  return VALID_BUILTIN_TOOL_NAMES.has(value) || value.startsWith("mcp__");
}

/** Balanced-bracket extraction of the first complete JSON object starting at startIdx. */
function extractFirstJson(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (ch === "\\") { escape = true; }
      else if (ch === '"') { inString = false; }
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

const learningCandidateCategories = new Set<LearningCandidateCategory>([
  "preference",
  "project",
  "pattern",
  "bugfix",
  "workflow"
]);

function normalizeCandidateKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

export function parseLearningExtractionContent(rawContent: string): LearningCandidate[] {
  const jsonStart = rawContent.indexOf("{");
  const jsonText = jsonStart >= 0 ? extractFirstJson(rawContent, jsonStart) : null;
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText) as { records?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.records)) return [];
    const records: LearningCandidate[] = [];
    for (const candidate of parsed.records.slice(0, 3)) {
      const category = typeof candidate.category === "string" ? candidate.category as LearningCandidateCategory : undefined;
      const title = typeof candidate.title === "string" ? candidate.title.trim().replace(/\s+/g, " ").slice(0, 120) : "";
      const insight = typeof candidate.insight === "string" ? candidate.insight.trim().replace(/\s+/g, " ").slice(0, 1200) : "";
      const evidence = typeof candidate.evidence === "string" ? candidate.evidence.trim().replace(/\s+/g, " ").slice(0, 600) : "";
      const dedupeKey = normalizeCandidateKey(typeof candidate.dedupeKey === "string" ? candidate.dedupeKey : "");
      const confidence = typeof candidate.confidence === "number" ? candidate.confidence : 0;
      const importance = typeof candidate.importance === "number" ? Math.max(1, Math.min(5, Math.round(candidate.importance))) : 2;
      if (
        candidate.reusable !== true ||
        !category ||
        !learningCandidateCategories.has(category) ||
        !dedupeKey ||
        title.length < 4 ||
        insight.length < 16 ||
        evidence.length < 8 ||
        confidence < 0.8
      ) continue;
      records.push({ dedupeKey, title, insight, category, evidence, importance, confidence: Math.min(1, confidence) });
    }
    return records.slice(0, 2);
  } catch {
    return [];
  }
}

/** Extract tool calls from text when the model does not support standard function calling. */
function parseToolCallsFromText(rawContent: string): { cleanContent: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let cleanContent = rawContent;

  function pushToolCall(name: string, args: Record<string, unknown>) {
    if (isToolName(name)) {
      toolCalls.push({ id: nanoid(), name, arguments: args });
    }
  }

  // Pattern 1: XML-style tool_call tags containing JSON
  const tcOpenTag = String.fromCharCode(60) + "tool_call";
  const tcCloseTag = String.fromCharCode(47) + "tool_call" + String.fromCharCode(62);
  const tcRegex = new RegExp(tcOpenTag + "\\s*(\\{)", "gi");
  const tcMatches: Array<{ name: string; args: Record<string, unknown>; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = tcRegex.exec(cleanContent)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const jsonStr = extractFirstJson(cleanContent, braceIdx);
    if (!jsonStr) continue;
    try {
      const parsed = JSON.parse(jsonStr);
      const name = parsed.name || parsed.function;
      if (name) {
        const end = braceIdx + jsonStr.length;
        const closeIdx = cleanContent.indexOf(tcCloseTag, end);
        const fullEnd = closeIdx !== -1 ? closeIdx + tcCloseTag.length : end;
        tcMatches.push({ name, args: parsed.arguments || parsed.parameters || {}, start: m.index, end: fullEnd });
      }
    } catch { /* ignore */ }
  }
  for (let i = tcMatches.length - 1; i >= 0; i--) {
    const match = tcMatches[i];
    pushToolCall(match.name, match.args);
    cleanContent = cleanContent.slice(0, match.start) + cleanContent.slice(match.end);
  }

  // Pattern 2: function_calls/invoke wrapper with inner function_call elements
  const fcOpen = String.fromCharCode(60) + "function_calls";
  const fcClose = String.fromCharCode(47) + "function_calls" + String.fromCharCode(62);
  const fcRegex = new RegExp(fcOpen + "[^" + String.fromCharCode(62) + "]*" + String.fromCharCode(62) + "\\s*([\\s\\S]*?)\\s*" + fcClose, "gi");
  cleanContent = cleanContent.replace(fcRegex, (_fullMatch, inner: string) => {
    const innerRegex = /<(?:function_call|invoke)\s+name=["'](\w+)["']\s*>\s*/gi;
    let im: RegExpExecArray | null;
    while ((im = innerRegex.exec(inner)) !== null) {
      const braceIdx = inner.indexOf("{", im.index + im[0].length);
      if (braceIdx === -1) continue;
      const jsonStr = extractFirstJson(inner, braceIdx);
      if (!jsonStr) continue;
      try {
        pushToolCall(im[1], JSON.parse(jsonStr));
      } catch {
        pushToolCall(im[1], {});
      }
    }
    return "";
  });

  // Pattern 3: text-formatted functions.xxx:N {...}
  // Uses balanced bracket matching to handle nested braces in code content
  const functionRegex = /functions\.(\w+)(?::\d+)?\s*/gi;
  const functionMatches: Array<{ name: string; args: Record<string, unknown> | null; start: number; end: number }> = [];
  let functionMatch: RegExpExecArray | null;
  while ((functionMatch = functionRegex.exec(cleanContent)) !== null) {
    const braceIdx = cleanContent.indexOf("{", functionMatch.index + functionMatch[0].length);
    if (braceIdx === -1) continue;
    const jsonStr = extractFirstJson(cleanContent, braceIdx);
    if (!jsonStr) continue;
    try {
      const parsed = JSON.parse(jsonStr);
      functionMatches.push({
        name: functionMatch[1],
        args: parsed,
        start: functionMatch.index,
        end: braceIdx + jsonStr.length
      });
    } catch { /* ignore */ }
  }
  for (let i = functionMatches.length - 1; i >= 0; i--) {
    const match = functionMatches[i];
    if (match.args) {
      pushToolCall(match.name, match.args);
      cleanContent = cleanContent.slice(0, match.start) + cleanContent.slice(match.end);
    }
  }

  cleanContent = cleanContent.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanContent, toolCalls };
}

function getWorkflowInstruction(mode: PermissionMode = "workspace_write") {
  if (mode === "plan") {
    return [
      "## Current workflow: Plan",
      "- Investigate only what is necessary with read-only workspace tools.",
      "- Do not edit files, run shell commands, access the network, or claim implementation is complete.",
      "- Resolve obvious details from the project before asking questions.",
      "- End with a concrete plan using this exact heading and checklist shape:",
      "## 执行计划",
      "1. [ ] A specific, verifiable step",
      "2. [ ] A specific, verifiable step",
      "- Keep the plan between 2 and 8 steps and mention validation in the last step."
    ].join("\n");
  }
  if (mode === "full_access") {
    return [
      "## Current workflow: Execute with full access",
      "- Full access is active for this turn. You may read, write, list, search, and run commands at user-requested local paths outside the current project.",
      "- Do not claim that an ordinary local path is blocked merely because it is outside the workspace. Call the appropriate tool and report only an actual tool or operating-system error.",
      "- Mandatory credential, secret-exfiltration, interactive-process, and destructive-operation safeguards still apply.",
      "- Inspect, implement, validate, and then report the outcome."
    ].join("\n");
  }
  return [
    "## Current workflow: Execute",
    "- Inspect, implement, validate, and then report the outcome.",
    "- Keep the user informed when moving from investigation to edits or validation.",
    "- If the conversation contains an approved plan, use it as the execution checklist and do not re-plan from scratch."
  ].join("\n");
}

function buildSystemPrompt(modelName: string, providerDisplayName: string, mode: PermissionMode = "workspace_write") {
  return [
    `You are Rcode, running inside the Rcode Desktop application on macOS.`,
    `Your current AI model is "${modelName}" provided by "${providerDisplayName}".`,
    "You are NOT Claude, NOT ChatGPT, NOT any other AI assistant. You are Rcode.",
    "Never claim to be Claude, Anthropic, OpenAI, or any other AI company's product.",
    "You help users write, modify, and debug code in their local projects.",
    "",
    "## Capabilities",
  "- read_file: Read a file's content before editing it.",
  "- write_file: Write or overwrite a file with its COMPLETE content in one call.",
  "- run_shell: Run shell commands (npm install, git, tests, build, etc.).",
  "- start_process/read_process/write_process/stop_process/list_processes: Manage long-running dev servers and watchers without &, nohup, or shell redirection.",
  "- git_status/git_diff/git_branch/git_stage/git_commit: Inspect and manage local git workflow with approval for mutating actions.",
  "- web_fetch: Fetch documentation or API references.",
  "- generate_image: Generate an image with the current provider's automatically detected image model.",
  "",
  "## Workflow Rules",
  "- ALWAYS explain what you are about to do in 1-2 sentences BEFORE calling tools.",
  "- When creating a project with multiple files, BATCH all write_file calls in a SINGLE response.",
  "- For example, if you need to create 5 files, output all 5 write_file tool calls together in one response, not one at a time.",
  "- Do NOT wait for one file to be written before writing the next. Output them all at once.",
  "- Only use run_shell for: npm install, git, running tests, building projects.",
  "- Use start_process for commands that stay running, such as npm run dev, Vite, Python HTTP servers, and file watchers. Never start those with run_shell.",
  "- Use read_process to verify startup output or inspect later logs, and stop_process when the user asks to stop a managed service.",
  "- NEVER use run_shell with echo/cat/sed/printf to write files. ALWAYS use write_file.",
  "- Always read_file before editing an existing file.",
  "- Use the project root as the working directory for all file paths.",
  "- When running shell commands, use non-interactive flags (e.g. --yes for npm).",
  "- Respond in the same language the user uses.",
  "- When the user asks to create, draw, render, or generate an image, call generate_image automatically instead of sending an image model to Chat Completions.",
  "- Treat a clear image-generation request as authorization for that image call. Do not call generate_image for image-related explanations, code, or analysis unless an actual generated image is requested.",
  "",
  getWorkflowInstruction(mode)
  ].join("\n");
}

function getThinkingInstruction(mode: ThinkingMode = "balanced") {
  if (mode === "fast") {
    return "Thinking mode: fast. Prefer direct answers and minimal exploration.";
  }
  if (mode === "deep") {
    return "Thinking mode: deep. Think through tradeoffs carefully before answering, while keeping the final answer readable.";
  }
  return "Thinking mode: balanced. Use enough reasoning to be reliable without over-explaining.";
}

function getConfig(modelOverride?: string, providerId?: string) {
  const runtimeConfig = getRuntimeConfig();
  const requestedProvider = providerId ? resolveAiProviderForExecution(providerId) : undefined;
  const provider = requestedProvider ?? runtimeConfig.provider;
  return {
    apiKey: provider.apiKey ?? (
      provider.apiKeyEnv
        ? process.env[provider.apiKeyEnv]
        : process.env.AI_API_KEY
    ),
    baseUrl: provider.baseUrl ?? process.env.AI_BASE_URL ?? "",
    chatPath: provider.chatCompletionsPath ?? "/chat/completions",
    model: modelOverride || provider.defaultModel || process.env.AI_MODEL || "",
    providerDisplayName: provider.displayName,
    reasoningDialect: provider.reasoningDialect ?? "auto",
    temperature: runtimeConfig.temperature,
    maxTokens: runtimeConfig.maxTokens
  };
}

function supportsPromptCacheKey(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "api.openai.com") return true;
    if (url.hostname === "api.kimi.com") {
      const pathname = url.pathname.replace(/\/$/, "");
      return pathname === "/coding" || pathname.startsWith("/coding/");
    }
  } catch {
    return false;
  }
  return false;
}

function escapeAttachmentName(value: string) {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

function toProviderMessageContent(message: AgentMessage): string | Array<Record<string, unknown>> {
  if (message.role !== "user" || !message.attachments?.length) return message.content;

  const textAttachments = message.attachments.filter((attachment) => attachment.text !== undefined);
  const textContent = [
    message.content,
    ...textAttachments.map((attachment) => [
      `<attached_file name="${escapeAttachmentName(attachment.name)}" mime_type="${escapeAttachmentName(attachment.mimeType)}">`,
      attachment.text,
      "</attached_file>"
    ].join("\n"))
  ].filter(Boolean).join("\n\n");
  const content: Array<Record<string, unknown>> = [];
  if (textContent) content.push({ type: "text", text: textContent });

  for (const attachment of message.attachments) {
    if (!attachment.dataUrl) continue;
    if (attachment.kind === "image") {
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl, detail: "auto" } });
    } else {
      content.push({
        type: "file",
        file: { filename: attachment.name, file_data: attachment.dataUrl }
      });
    }
  }
  return content.length > 0 ? content : message.content;
}

async function toProviderMessages(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  thinkingMode?: ThinkingMode,
  projectPath?: string,
  modelName?: string,
  providerDisplayName?: string,
  mode: PermissionMode = "workspace_write",
  reasoningConfig?: ReasoningRequestConfig
) {
  const projectInstruction = projectPath
    ? mode === "full_access"
      ? `Current project root: ${projectPath}. Resolve relative paths from this project, but full access is active and explicit absolute paths outside it are allowed.`
      : `Current project root: ${projectPath}. Resolve relative file paths and shell commands inside this project unless the user asks otherwise.`
    : "Current project type: empty project. Use relative file paths from the app workspace unless the user provides a folder path.";
  const latestUserPrompt = [...messages].reverse().find((message) =>
    message.role === "user" && !message.content.startsWith("Visual result returned by tool ")
  )?.content ?? "";
  const projectContext = await buildProjectContextBundle(projectPath, latestUserPrompt);
  const totalBudgetTokens = 16_000;
  const contextOverheadTokens = Math.ceil(projectContext.content.length / 4) + 1_200;
  const compacted = compactMessagesWithSnapshot(messages, Math.max(4_000, totalBudgetTokens - contextOverheadTokens));
  const providerMessages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: [
        buildSystemPrompt(modelName ?? "unknown", providerDisplayName ?? "unknown", mode),
        getThinkingInstruction(thinkingMode),
        projectInstruction,
        projectContext.content ? `\n## Project Context\n${projectContext.content}` : ""
      ].filter(Boolean).join("\n")
    },
    ...compacted.messages.map((message) => {
      if (message.role === "tool") {
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      }
      if (message.role === "assistant") {
        const hasToolCalls = Boolean(message.toolCalls?.length);
        const shouldReplayReasoning = reasoningConfig?.replay === "all" || (reasoningConfig?.replay === "tool_calls" && hasToolCalls);
        const reasoningFields = shouldReplayReasoning
          ? reasoningConfig?.replayField === "reasoning_details" && message.reasoningDetails
            ? { reasoning_details: message.reasoningDetails }
            : message.reasoningContent
              ? { reasoning_content: message.reasoningContent }
              : {}
          : {};
        if (!hasToolCalls) return { role: "assistant", content: message.content, ...reasoningFields };
        return {
          role: "assistant",
          content: message.content || null,
          ...reasoningFields,
          tool_calls: message.toolCalls!.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) }
          }))
        };
      }
      return { role: message.role, content: toProviderMessageContent(message) };
    })
  ];

  for (const result of toolResults) {
    providerMessages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
  }

  const snapshot: ContextSnapshot = {
    ...compacted.snapshot,
    budgetTokens: totalBudgetTokens,
    estimatedTokens: compacted.snapshot.estimatedTokens + contextOverheadTokens,
    projectContextChars: projectContext.content.length,
    activeSkills: projectContext.activeSkills
  };
  return { messages: providerMessages, snapshot };
}

async function getToolsForMode(projectPath: string | undefined, mode: PermissionMode = "workspace_write") {
  const tools = await getToolDefinitions(projectPath);
  if (mode !== "plan") return tools;
  const readOnlyTools = new Set(["read_file", "list_files", "search_text", "inspect_tree", "git_status", "git_diff"]);
  return tools.filter((tool) => readOnlyTools.has(tool.function.name));
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseApprovalAudit(rawContent: string): ApprovalAuditResult | undefined {
  const jsonStart = rawContent.indexOf("{");
  if (jsonStart === -1) return undefined;
  const jsonText = extractFirstJson(rawContent, jsonStart);
  if (!jsonText) return undefined;

  try {
    const parsed = JSON.parse(jsonText) as Partial<ApprovalAuditResult>;
    if (typeof parsed.allow !== "boolean") return undefined;
    const risk: ToolRisk = parsed.risk === "low" || parsed.risk === "medium" || parsed.risk === "high"
      ? parsed.risk
      : parsed.allow
        ? "low"
        : "high";
    return {
      allow: parsed.allow,
      risk,
      reason: typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 240)
        : parsed.allow
          ? "模型审核认为该工具调用可以自动执行。"
          : "模型审核认为该工具调用需要人工审批。"
    };
  } catch {
    return undefined;
  }
}

export async function auditToolCallApproval(
  toolCall: ToolCall,
  options: { model?: string; projectPath?: string; signal?: AbortSignal } = {}
): Promise<ApprovalAuditResult | undefined> {
  const config = getConfig(options.model);
  if (!config.apiKey) return undefined;

  const projectPath = options.projectPath || process.cwd();
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`, {
    method: "POST",
    signal: options.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: [
            "You are Rcode's security and permission reviewer. You are NOT Claude or any other AI assistant.",
            "Decide whether a proposed tool call may run automatically under auto-approve mode.",
            "Return ONLY compact JSON with this shape: {\"allow\": boolean, \"risk\": \"low\"|\"medium\"|\"high\", \"reason\": string}.",
            "Allow routine reads/writes/build/test commands that are clearly scoped to the current project.",
            "Do not allow destructive, irreversible, credential/secret access, exfiltration, privilege escalation, system-wide changes, or operations outside the current project.",
            "If the scope is ambiguous, set allow=false and explain what needs human approval."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            currentProjectRoot: projectPath,
            toolCall
          })
        }
      ],
      temperature: 0,
      max_tokens: 300
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI approval audit error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content ?? "";
  return parseApprovalAudit(content);
}

export async function extractLearningCandidates(
  transcript: string,
  options: { model?: string; projectPath?: string; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<LearningExtractionResult> {
  const config = getConfig(options.model);
  if (!config.apiKey) throw new Error("AI provider is not configured for automatic learning");

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Automatic learning extraction timed out")), options.timeoutMs ?? 20_000);

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: [
              "You are Rcode's post-task learning verifier.",
              "Extract at most two durable lessons from the completed turn. Return ONLY one compact JSON object with a records array.",
              "A record is allowed only when the transcript contains concrete evidence and the lesson is likely to change future work in the same project.",
              "Reject routine progress, generic software advice, one-off commands, guessed causes, raw logs, secrets, credentials, personal data, and facts already obvious from source files.",
              "Use an empty records array when nothing qualifies. Never invent missing verification.",
              "Each record must contain: dedupeKey, title, insight, category, evidence, importance, confidence, reusable.",
              "dedupeKey must be a short stable concept key; category must be preference, project, pattern, bugfix, or workflow; confidence is 0 to 1; reusable must be true.",
              "Evidence must summarize the exact observed command, test, file, or user instruction that verified the lesson without copying sensitive or lengthy output.",
              "Schema: {\"records\":[{\"dedupeKey\":\"...\",\"title\":\"...\",\"insight\":\"...\",\"category\":\"workflow\",\"evidence\":\"...\",\"importance\":2,\"confidence\":0.9,\"reusable\":true}]}"
            ].join("\n")
          },
          {
            role: "user",
            content: [
              options.projectPath ? `Project root: ${options.projectPath}` : "",
              "Completed turn evidence:",
              transcript.slice(0, 12_000)
            ].filter(Boolean).join("\n")
          }
        ],
        temperature: 0,
        max_tokens: Math.min(1_000, config.maxTokens)
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Automatic learning provider error ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = (await response.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonStart = content.indexOf("{");
    const jsonText = jsonStart >= 0 ? extractFirstJson(content, jsonStart) : null;
    let hasStructuredEnvelope = false;
    if (jsonText) {
      try {
        hasStructuredEnvelope = Array.isArray((JSON.parse(jsonText) as { records?: unknown }).records);
      } catch {
        hasStructuredEnvelope = false;
      }
    }
    if (!hasStructuredEnvelope) throw new Error("Automatic learning verifier returned invalid structured output");
    return {
      records: parseLearningExtractionContent(content),
      usage: data.usage,
      model: config.model,
      provider: config.providerDisplayName
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

/** Non-streaming AI call (kept for fallback). */
export async function callAi(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  options: { providerId?: string; model?: string; thinkingMode?: ThinkingMode; projectPath?: string; mode?: PermissionMode; signal?: AbortSignal } = {}
): Promise<AiTurn> {
  const config = getConfig(options.model, options.providerId);

  if (!config.apiKey) {
    return {
      content: "AI_API_KEY 尚未配置。当前框架已就绪：配置 .env 后即可连接兼容 OpenAI Chat Completions 的模型，并按权限模式执行工具调用。",
      toolCalls: []
    };
  }

  const reasoning = buildReasoningRequestConfig(config.baseUrl, config.model, options.thinkingMode, config.reasoningDialect);
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`;
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: (await toProviderMessages(messages, toolResults, options.thinkingMode, options.projectPath, config.model, config.providerDisplayName, options.mode, reasoning)).messages,
    tools: await getToolsForMode(options.projectPath, options.mode),
    tool_choice: "auto",
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...reasoning.parameters
  };
  for (const parameter of reasoning.omitParameters ?? []) delete requestBody[parameter];
  const sendRequest = (body: Record<string, unknown>) => fetch(endpoint, {
    method: "POST",
    signal: options.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body)
  });

  let activeRequestBody = requestBody;
  let response = await sendRequest(activeRequestBody);
  if (!response.ok) {
    const errorBody = await response.text();
    const fallbackBody = { ...activeRequestBody };
    const canRetry = (response.status === 400 || response.status === 422) && removeUnsupportedReasoningControls(
      fallbackBody,
      errorBody,
      reasoningTargetKey(config.baseUrl, config.model, config.reasoningDialect)
    );
    if (!canRetry) throw new Error(`AI provider error ${response.status}: ${errorBody.slice(0, 500)}`);
    activeRequestBody = fallbackBody;
    response = await sendRequest(activeRequestBody);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI provider error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as ChatResponse;
  const message = data.choices?.[0]?.message;
  const rawContent = message?.content ?? "";

  let toolCalls: ToolCall[] =
    message?.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name as ToolCall["name"],
      arguments: parseToolArguments(toolCall.function.arguments)
    })) ?? [];

  let displayContent = rawContent;
  if (toolCalls.length === 0 && rawContent) {
    const parsed = parseToolCallsFromText(rawContent);
    toolCalls = parsed.toolCalls;
    displayContent = parsed.cleanContent;
  }

  return {
    content: displayContent,
    toolCalls,
    reasoningContent: message?.reasoning_content ?? undefined,
    reasoningDetails: message?.reasoning_details ?? undefined
  };
}

/** Streaming AI call: yields text deltas token-by-token, returns tool calls at the end. */
export async function* callAiStream(
  messages: AgentMessage[],
  options: { providerId?: string; model?: string; thinkingMode?: ThinkingMode; projectPath?: string; mode?: PermissionMode; sessionId?: string; signal?: AbortSignal } = {}
): AsyncGenerator<
  | { type: "text_delta"; content: string }
  | { type: "usage"; usage: AiUsage; model: string; provider: string; requestId: string }
  | { type: "context_snapshot"; snapshot: ContextSnapshot }
  | { type: "reasoning_config"; config: AppliedReasoningConfig }
  | { type: "tool_calls"; toolCalls: ToolCall[]; cleanContent?: string; reasoningContent?: string; reasoningDetails?: Array<Record<string, unknown>> }
> {
  const config = getConfig(options.model, options.providerId);

  if (!config.apiKey) {
    yield { type: "text_delta", content: "AI_API_KEY 尚未配置。当前框架已就绪：配置 .env 后即可连接兼容 OpenAI Chat Completions 的模型，并按权限模式执行工具调用。" };
    yield { type: "tool_calls", toolCalls: [] };
    return;
  }

  const selectedThinkingMode = options.thinkingMode ?? "balanced";
  const reasoning = buildReasoningRequestConfig(config.baseUrl, config.model, selectedThinkingMode, config.reasoningDialect);
  const providerContext = await toProviderMessages(messages, [], options.thinkingMode, options.projectPath, config.model, config.providerDisplayName, options.mode, reasoning);
  yield { type: "context_snapshot", snapshot: providerContext.snapshot };
  const tools = await getToolsForMode(options.projectPath, options.mode);
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: providerContext.messages,
    tools,
    tool_choice: "auto",
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...reasoning.parameters
  };
  for (const parameter of reasoning.omitParameters ?? []) delete requestBody[parameter];

  // A stable session key improves upstream prefix-cache routing. Like CC
  // Switch, auto mode is conservative: only endpoints known to accept this
  // field receive it, and per-request random IDs are never used as cache keys.
  if (options.sessionId && supportsPromptCacheKey(config.baseUrl)) {
    requestBody.prompt_cache_key = options.sessionId;
  }

  const endpoint = `${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`;
  const sendRequest = (body: Record<string, unknown>) => fetch(endpoint, {
    method: "POST",
    signal: options.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body)
  });

  let activeRequestBody = requestBody;
  let response = await sendRequest(activeRequestBody);
  if (!response.ok) {
    const errorBody = await response.text();
    const canRetry = response.status === 400 || response.status === 422;
    const fallbackBody = { ...activeRequestBody };
    let changed = false;
    if (canRetry && /stream_options|include_usage/i.test(errorBody) && "stream_options" in fallbackBody) {
      delete fallbackBody.stream_options;
      changed = true;
    }
    if (canRetry && /prompt_cache_key/i.test(errorBody) && "prompt_cache_key" in fallbackBody) {
      delete fallbackBody.prompt_cache_key;
      changed = true;
    }
    if (canRetry && removeUnsupportedReasoningControls(
      fallbackBody,
      errorBody,
      reasoningTargetKey(config.baseUrl, config.model, config.reasoningDialect)
    )) {
      changed = true;
    }
    if (!changed) {
      throw new Error(`AI provider error ${response.status}: ${errorBody.slice(0, 500)}`);
    }
    activeRequestBody = fallbackBody;
    response = await sendRequest(activeRequestBody);
    if (!response.ok) {
      const fallbackErrorBody = await response.text();
      throw new Error(`AI provider error ${response.status}: ${fallbackErrorBody.slice(0, 500)}`);
    }
  }

  yield {
    type: "reasoning_config",
    config: effectiveReasoningConfig(reasoning, activeRequestBody)
  };

  if (!response.body) throw new Error("AI provider returned an empty streaming response");
  const providerRequestId = nanoid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentBuffer = "";
  let reasoningContentBuffer = "";
  let reasoningDetailsBuffer: Array<Record<string, unknown>> | undefined;
  const toolCallMap = new Map<number, { id: string; name: string; argsBuffer: string }>();
  let finalUsage: AiUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (done) buffer += decoder.decode();
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trimStart();
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as StreamChunk;
        if (chunk.usage) {
          // Compatible providers may repeat usage across terminal chunks. Keep
          // only the last payload and emit one request-level record at EOF.
          finalUsage = chunk.usage;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          contentBuffer += delta.content;
          yield { type: "text_delta", content: delta.content };
        }

        if (delta.reasoning_content) {
          reasoningContentBuffer = appendReasoningText(reasoningContentBuffer, delta.reasoning_content);
        }

        if (delta.reasoning_details?.length) {
          reasoningDetailsBuffer = mergeReasoningDetails(reasoningDetailsBuffer, delta.reasoning_details);
          if (!delta.reasoning_content) {
            reasoningContentBuffer = appendReasoningText(reasoningContentBuffer, reasoningDetailsText(delta.reasoning_details));
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id ?? nanoid(), name: "", argsBuffer: "" });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.argsBuffer += tc.function.arguments;
          }
        }
      } catch { /* ignore non-JSON provider events */ }
    }
    if (done) break;
  }

  if (finalUsage) {
    yield {
      type: "usage",
      usage: finalUsage,
      model: config.model,
      provider: config.providerDisplayName,
      requestId: providerRequestId
    };
  }

  // Build final tool call list from accumulated deltas
  const toolCalls: ToolCall[] = [];
  for (const [, entry] of toolCallMap) {
    toolCalls.push({
      id: entry.id,
      name: entry.name as ToolCall["name"],
      arguments: parseToolArguments(entry.argsBuffer)
    });
  }

  // If no structured tool calls, try extracting from text-formatted tool calls.
  if (toolCalls.length === 0 && contentBuffer) {
    const parsed = parseToolCallsFromText(contentBuffer);
    if (parsed.toolCalls.length > 0) {
      yield { type: "tool_calls", toolCalls: parsed.toolCalls, cleanContent: parsed.cleanContent, reasoningContent: reasoningContentBuffer, reasoningDetails: reasoningDetailsBuffer };
      return;
    }
  }

  yield { type: "tool_calls", toolCalls, reasoningContent: reasoningContentBuffer, reasoningDetails: reasoningDetailsBuffer };
}
