import assert from "node:assert/strict";
import test from "node:test";
import { buildLearningTranscript, evaluateLearningTurn, runAutoLearning } from "./autoLearning";
import { parseLearningExtractionContent } from "../providers/aiProvider";
import type { AgentMessage } from "../shared/types";

const verifiedTurn: AgentMessage[] = [
  { role: "user", content: "修复这个项目的格式检查" },
  {
    role: "assistant",
    content: "我先运行检查。",
    toolCalls: [{ id: "call_1", name: "run_shell", arguments: { command: "npm run format:check" } }]
  },
  { role: "tool", toolCallId: "call_1", content: "Formatting check failed in src/App.tsx" },
  {
    role: "assistant",
    content: "运行项目格式化器。",
    toolCalls: [{ id: "call_2", name: "run_shell", arguments: { command: "npm run format" } }]
  },
  { role: "tool", toolCallId: "call_2", content: "Formatted src/App.tsx" },
  {
    role: "assistant",
    content: "再次检查。",
    toolCalls: [{ id: "call_3", name: "run_shell", arguments: { command: "npm run format:check" } }]
  },
  { role: "tool", toolCallId: "call_3", content: "Formatting check passed" },
  { role: "assistant", content: "格式检查已经通过。", toolCalls: [] }
];

test("automatic learning only evaluates turns with evidence or an explicit preference", () => {
  assert.equal(evaluateLearningTurn([{ role: "user", content: "你好" }, { role: "assistant", content: "你好" }]).eligible, false);
  assert.equal(evaluateLearningTurn(verifiedTurn).eligible, true);
  assert.match(buildLearningTranscript(verifiedTurn), /Formatting check passed/);
});

test("learning extraction parser enforces reusable evidence and confidence", () => {
  const parsed = parseLearningExtractionContent(JSON.stringify({
    records: [
      {
        dedupeKey: "workflow-project-formatter",
        title: "修改 TypeScript 后运行项目格式化器",
        insight: "编辑 TypeScript 文件后运行 npm run format，并用 npm run format:check 验证。",
        category: "workflow",
        evidence: "格式化后 npm run format:check 返回 passed。",
        importance: 3,
        confidence: 0.94,
        reusable: true
      },
      {
        dedupeKey: "weak-guess",
        title: "猜测",
        insight: "这个内容没有足够的证据支持，因此不应保存。",
        category: "pattern",
        evidence: "没有验证",
        importance: 2,
        confidence: 0.4,
        reusable: true
      }
    ]
  }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].dedupeKey, "workflow-project-formatter");
});

test("completion-stage learning persists qualified candidates and exposes run status", async () => {
  const savedInputs: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const result = await runAutoLearning({
    messages: verifiedTurn,
    projectPath: "/tmp/project",
    conversationId: "conversation_1",
    requestId: "request_1",
    model: "test-model"
  }, {
    extract: async () => ({
      records: [{
        dedupeKey: "workflow-project-formatter",
        title: "修改 TypeScript 后运行项目格式化器",
        insight: "编辑 TypeScript 文件后运行 npm run format，并用 npm run format:check 验证。",
        category: "workflow",
        evidence: "格式化后 npm run format:check 返回 passed。",
        importance: 3,
        confidence: 0.94
      }],
      model: "test-model",
      provider: "test-provider"
    }),
    save: (input) => {
      savedInputs.push(input as unknown as Record<string, unknown>);
      return {
        id: "learning_1",
        projectPath: input.projectPath,
        conversationId: input.conversationId,
        title: input.title,
        insight: input.insight,
        category: input.category ?? "pattern",
        evidence: input.evidence,
        importance: input.importance ?? 2,
        dedupeKey: input.dedupeKey,
        source: input.source ?? "agent",
        confidence: input.confidence ?? 1,
        confirmationCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    },
    saveRun: (input) => {
      runs.push(input as unknown as Record<string, unknown>);
      return {
        id: "run_1",
        projectPath: input.projectPath,
        conversationId: input.conversationId,
        status: input.status,
        reason: input.reason,
        recordsSaved: input.recordsSaved ?? 0,
        createdAt: "2026-01-01T00:00:00.000Z"
      };
    },
    audit: (input) => {
      audits.push(input as unknown as Record<string, unknown>);
      return "audit_1";
    },
    usage: () => "usage_1"
  });

  assert.equal(result.run.status, "saved");
  assert.equal(result.records.length, 1);
  assert.equal(savedInputs[0].source, "automatic");
  assert.equal(runs.length, 1);
  assert.equal(audits.length, 1);
});

test("learning provider failures are recorded without escaping into the user task", async () => {
  const result = await runAutoLearning({
    messages: verifiedTurn,
    projectPath: "/tmp/project",
    conversationId: "conversation_2"
  }, {
    extract: async () => { throw new Error("provider unavailable"); },
    save: () => { throw new Error("save should not run"); },
    saveRun: (input) => ({
      id: "run_failed",
      projectPath: input.projectPath,
      conversationId: input.conversationId,
      status: input.status,
      reason: input.reason,
      recordsSaved: input.recordsSaved ?? 0,
      createdAt: "2026-01-01T00:00:00.000Z"
    }),
    audit: () => "audit_unused",
    usage: () => "usage_unused"
  });
  assert.equal(result.run.status, "failed");
  assert.match(result.run.reason, /provider unavailable/);
  assert.equal(result.records.length, 0);
});
