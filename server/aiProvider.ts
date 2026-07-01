import { toolDefinitions } from "./tools";
import type { AgentMessage, ToolCall, ToolResult, AgentToolName, ToolRisk } from "./types";
import { getRuntimeConfig } from "./config";
import { nanoid } from "nanoid";

interface ChatChoice {
  message?: {
    content?: string | null;
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
}

interface StreamDelta {
  content?: string;
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
}

export interface AiTurn {
  content: string;
  toolCalls: ToolCall[];
}

export interface ApprovalAuditResult {
  allow: boolean;
  risk: ToolRisk;
  reason: string;
}

export type ThinkingMode = "fast" | "balanced" | "deep";

const VALID_TOOL_NAMES: readonly string[] = toolDefinitions.map((t) => t.function.name);

function isToolName(value: string): value is AgentToolName {
  return (VALID_TOOL_NAMES as readonly string[]).includes(value);
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

const baseSystemPrompt = [
  "You are a software engineering agent. You help users write, modify, and debug code.",
  "",
  "## Capabilities",
  "- read_file: Read a file's content before editing it.",
  "- write_file: Write or overwrite a file with its COMPLETE content in one call.",
  "- run_shell: Run shell commands (npm install, git, tests, build, etc.).",
  "- web_fetch: Fetch documentation or API references.",
  "",
  "## Workflow Rules",
  "- ALWAYS explain what you are about to do in 1-2 sentences BEFORE calling tools.",
  "- When creating a project with multiple files, BATCH all write_file calls in a SINGLE response.",
  "- For example, if you need to create 5 files, output all 5 write_file tool calls together in one response, not one at a time.",
  "- Do NOT wait for one file to be written before writing the next. Output them all at once.",
  "- Only use run_shell for: npm install, git, running tests, building projects.",
  "- NEVER use run_shell with echo/cat/sed/printf to write files. ALWAYS use write_file.",
  "- Always read_file before editing an existing file.",
  "- Use the project root as the working directory for all file paths.",
  "- When running shell commands, use non-interactive flags (e.g. --yes for npm).",
  "- Respond in the same language the user uses."
].join("\n");

function getThinkingInstruction(mode: ThinkingMode = "balanced") {
  if (mode === "fast") {
    return "Thinking mode: fast. Prefer direct answers and minimal exploration.";
  }
  if (mode === "deep") {
    return "Thinking mode: deep. Think through tradeoffs carefully before answering, while keeping the final answer readable.";
  }
  return "Thinking mode: balanced. Use enough reasoning to be reliable without over-explaining.";
}

function getConfig(modelOverride?: string) {
  const runtimeConfig = getRuntimeConfig();
  return {
    apiKey: process.env.AI_API_KEY ?? process.env[runtimeConfig.provider.apiKeyEnv],
    baseUrl: process.env.AI_BASE_URL ?? runtimeConfig.provider.baseUrl,
    chatPath: runtimeConfig.provider.chatCompletionsPath ?? "/chat/completions",
    model: modelOverride || process.env.AI_MODEL || runtimeConfig.provider.defaultModel,
    temperature: runtimeConfig.temperature,
    maxTokens: runtimeConfig.maxTokens
  };
}

function toProviderMessages(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  thinkingMode?: ThinkingMode,
  projectPath?: string
) {
  const projectInstruction = projectPath
    ? `Current project root: ${projectPath}. Resolve relative file paths and shell commands inside this project unless the user asks otherwise.`
    : "Current project type: empty project. Use relative file paths from the app workspace unless the user provides a folder path.";
  const providerMessages: Array<Record<string, unknown>> = [
    { role: "system", content: `${baseSystemPrompt}\n${getThinkingInstruction(thinkingMode)}\n${projectInstruction}` },
    ...messages.map((message) => {
      if (message.role === "tool") {
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) }
          }))
        };
      }
      return { role: message.role, content: message.content };
    })
  ];

  for (const result of toolResults) {
    providerMessages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
  }

  return providerMessages;
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
            "You are a security and permission reviewer for a local coding agent.",
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

/** Non-streaming AI call (kept for fallback). */
export async function callAi(
  messages: AgentMessage[],
  toolResults: ToolResult[] = [],
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; signal?: AbortSignal } = {}
): Promise<AiTurn> {
  const config = getConfig(options.model);

  if (!config.apiKey) {
    return {
      content: "AI_API_KEY 尚未配置。当前框架已就绪：配置 .env 后即可连接兼容 OpenAI Chat Completions 的模型，并按权限模式执行工具调用。",
      toolCalls: []
    };
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`, {
    method: "POST",
    signal: options.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: toProviderMessages(messages, toolResults, options.thinkingMode, options.projectPath),
      tools: toolDefinitions,
      tool_choice: "auto",
      temperature: config.temperature,
      max_tokens: config.maxTokens
    })
  });

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

  return { content: displayContent, toolCalls };
}

/** Streaming AI call: yields text deltas token-by-token, returns tool calls at the end. */
export async function* callAiStream(
  messages: AgentMessage[],
  options: { model?: string; thinkingMode?: ThinkingMode; projectPath?: string; signal?: AbortSignal } = {}
): AsyncGenerator<{ type: "text_delta"; content: string } | { type: "tool_calls"; toolCalls: ToolCall[]; cleanContent?: string }> {
  const config = getConfig(options.model);

  if (!config.apiKey) {
    yield { type: "text_delta", content: "AI_API_KEY 尚未配置。当前框架已就绪：配置 .env 后即可连接兼容 OpenAI Chat Completions 的模型，并按权限模式执行工具调用。" };
    yield { type: "tool_calls", toolCalls: [] };
    return;
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${config.chatPath}`, {
    method: "POST",
    signal: options.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: toProviderMessages(messages, [], options.thinkingMode, options.projectPath),
      tools: toolDefinitions,
      tool_choice: "auto",
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI provider error ${response.status}: ${body.slice(0, 500)}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentBuffer = "";
  const toolCallMap = new Map<number, { id: string; name: string; argsBuffer: string }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const chunk = JSON.parse(data) as StreamChunk;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          contentBuffer += delta.content;
          yield { type: "text_delta", content: delta.content };
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
      } catch { /* ignore parse errors */ }
    }
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
      yield { type: "tool_calls", toolCalls: parsed.toolCalls, cleanContent: parsed.cleanContent };
      return;
    }
  }

  yield { type: "tool_calls", toolCalls };
}
