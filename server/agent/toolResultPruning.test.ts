import assert from "node:assert/strict";
import test from "node:test";
import { assignTurnIndexes, defaultToolResultPruningConfig, pruneToolResults } from "./toolResultPruning";
import type { AgentMessage } from "../shared/types";

function makeMessages(turnCount: number, toolContentSize: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < turnCount; i++) {
    messages.push({ role: "user", content: `turn ${i}` });
    messages.push({
      role: "assistant",
      content: `call tool in turn ${i}`,
      toolCalls: [{ id: `c_${i}`, name: "run_shell", arguments: {} }]
    });
    messages.push({ role: "tool", toolCallId: `c_${i}`, content: `out_${i}_` + "x".repeat(toolContentSize) });
  }
  return messages;
}

test("assignTurnIndexes groups messages by user boundaries", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "tool", toolCallId: "c1", content: "r1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" }
  ];
  assert.deepEqual(assignTurnIndexes(messages), [0, 0, 0, 1, 1]);
});

test("recent tool results within keepLastNTurns are not pruned", () => {
  const messages = makeMessages(2, 10_000);
  const config = { ...defaultToolResultPruningConfig, keepLastNTurns: 3, hardClearAgeTurns: 10 };
  const pruned = pruneToolResults(messages, config);
  // 所有 tool 消息都在最近 3 轮内,原样保留
  assert.equal(pruned[2].content?.length, 10_000 + 6);
  assert.equal(pruned[5]?.content?.length, 10_000 + 6);
});

test("middle-aged tool results are soft-trimmed", () => {
  // 5 轮,最新的是 turn 4;turn 0 age=4,处于 soft-trim 区
  const messages = makeMessages(5, 10_000);
  const config = {
    ...defaultToolResultPruningConfig,
    keepLastNTurns: 2,
    softTrimThresholdChars: 4_000,
    softTrimHeadChars: 100,
    softTrimTailChars: 100,
    hardClearAgeTurns: 10
  };
  const pruned = pruneToolResults(messages, config);
  // turn 0 的 tool 在 index=2: age=4 → soft trim
  const softTrimmed = pruned[2];
  assert.ok(softTrimmed.content.length < 10_000);
  assert.match(softTrimmed.content, /chars trimmed from middle/);
  assert.ok(softTrimmed.content.startsWith("out_0_"));
  // 最新一轮 turn 4 的 tool 在 index=14: age=0 → 保留
  const latest = pruned[14];
  // 前缀 "out_4_" 长 6 字符
  assert.equal(latest.content.length, 10_000 + 6);
});

test("old tool results beyond hardClearAgeTurns become placeholder", () => {
  const messages = makeMessages(15, 10_000);
  const config = {
    ...defaultToolResultPruningConfig,
    keepLastNTurns: 2,
    softTrimThresholdChars: 4_000,
    softTrimHeadChars: 100,
    softTrimTailChars: 100,
    hardClearAgeTurns: 5
  };
  const pruned = pruneToolResults(messages, config);
  // turn 0 的 tool 在 index=2: age=14 → hard clear
  assert.match(pruned[2].content, /old tool output cleared/);
  // 最新一轮 turn 14 的 tool 在 index=44: age=0 → 保留
  // 前缀 "out_14_" 长 7 字符
  assert.equal(pruned[44].content.length, 10_000 + 7);
});

test("disabled pruning returns messages unchanged", () => {
  const messages = makeMessages(20, 10_000);
  const pruned = pruneToolResults(messages, { ...defaultToolResultPruningConfig, enabled: false });
  assert.equal(pruned[2].content.length, 10_000 + 6);
});

test("non-tool messages are never modified", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "x".repeat(20_000) },
    { role: "assistant", content: "y".repeat(20_000) },
    { role: "tool", toolCallId: "c", content: "z".repeat(20_000) }
  ];
  const config = { ...defaultToolResultPruningConfig, keepLastNTurns: 0, softTrimThresholdChars: 100, hardClearAgeTurns: 99 };
  const pruned = pruneToolResults(messages, config);
  assert.equal(pruned[0].content.length, 20_000);
  assert.equal(pruned[1].content.length, 20_000);
  // tool 消息内容会变(age=0 不在 keepLastNTurns=0 之外,等于边界)
  // keepLastNTurns=0 意味着连最新都剪;hardClearAgeTurns=99 走 soft trim
  assert.ok(pruned[2].content.length < 20_000);
});
