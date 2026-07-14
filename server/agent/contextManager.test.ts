import assert from "node:assert/strict";
import test from "node:test";
import { compactMessagesWithSnapshot, estimateMessageTokens } from "./contextManager";
import type { AgentMessage } from "../shared/types";

test("context compaction keeps the latest complete tool turn", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: `old request ${"a".repeat(12_000)}` },
    { role: "assistant", content: "old response" },
    { role: "user", content: "inspect the current implementation" },
    {
      role: "assistant",
      content: "I will inspect it.",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "src/App.tsx" } }]
    },
    { role: "tool", toolCallId: "call_1", content: `file output ${"b".repeat(8_000)}` }
  ];

  const result = compactMessagesWithSnapshot(messages, 1_200);

  assert.equal(result.snapshot.compactedMessageCount, 2);
  assert.equal(result.messages[0].role, "system");
  assert.match(result.messages[0].content, /Earlier conversation summary/);
  assert.equal(result.messages.at(-3)?.role, "user");
  assert.equal(result.messages.at(-2)?.toolCalls?.[0].id, "call_1");
  assert.equal(result.messages.at(-1)?.toolCallId, "call_1");
  assert.match(result.messages.at(-1)?.content ?? "", /tool output compacted/);
});

test("message token estimate includes structured tool arguments", () => {
  const plain = estimateMessageTokens({ role: "assistant", content: "read" });
  const withTool = estimateMessageTokens({
    role: "assistant",
    content: "read",
    toolCalls: [{ id: "call", name: "read_file", arguments: { path: "a".repeat(400) } }]
  });
  assert.ok(withTool > plain);
});
