import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLastUserQuery,
  extractUserQuery,
  prepareForSummarization,
  stripImages,
  stripReasoning,
  stripSystemTags,
  truncateTrailingIncompleteToolCall
} from "./contextStrip";
import type { AgentMessage } from "../shared/types";

test("stripSystemTags removes known tags", () => {
  const text = `before <user_info>OS Version: darwin</user_info> middle <git_status>branch main</git_status> after`;
  assert.equal(stripSystemTags(text), "before  middle  after");
});

test("stripSystemTags keeps unclosed tags intact", () => {
  const text = `hello <user_info>incomplete`;
  assert.equal(stripSystemTags(text), text);
});

test("stripSystemTags leaves unknown tags alone", () => {
  const text = `<custom>real content</custom>`;
  assert.equal(stripSystemTags(text), text);
});

test("extractUserQuery pulls user_query content", () => {
  const text = `<system-reminder>ignore</system-reminder><user_query><user_info>meta</user_info>real question</user_query>`;
  assert.equal(extractUserQuery(text), "real question");
});

test("extractUserQuery falls back to stripped text when no user_query tag", () => {
  const text = `<project_layout>files...</project_layout>actual content`;
  assert.equal(extractUserQuery(text), "actual content");
});

test("extractLastUserQuery walks backward to find last user message", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "<user_info>meta</user_info>second question" },
    { role: "assistant", content: "latest answer" }
  ];
  assert.equal(extractLastUserQuery(messages), "second question");
});

test("stripReasoning removes reasoning fields", () => {
  const msg: AgentMessage = {
    role: "assistant",
    content: "answer",
    reasoningContent: "thinking...",
    reasoningDetails: [{ type: "thinking", text: "..." }]
  };
  const stripped = stripReasoning(msg);
  assert.equal(stripped.content, "answer");
  assert.equal(stripped.reasoningContent, undefined);
  assert.equal(stripped.reasoningDetails, undefined);
  // 原对象不被修改
  assert.equal(msg.reasoningContent, "thinking...");
});

test("stripImages replaces image attachments with placeholder", () => {
  const msg: AgentMessage = {
    role: "user",
    content: "what is this?",
    attachments: [
      { id: "img1", name: "a.png", mimeType: "image/png", size: 100, kind: "image", dataUrl: "data:image/png;base64,AAAA" },
      { id: "file1", name: "notes.txt", mimeType: "text/plain", size: 50, kind: "file", text: "hello" }
    ]
  };
  const stripped = stripImages(msg);
  assert.equal(stripped.attachments?.length, 1);
  assert.equal(stripped.attachments?.[0].kind, "file");
  assert.match(stripped.content, /\[image\]/);
});

test("prepareForSummarization strips tags + reasoning + images", () => {
  const msg: AgentMessage = {
    role: "user",
    content: "<user_info>meta</user_info>real question",
    reasoningContent: "...",
    attachments: [{ id: "i", name: "a.png", mimeType: "image/png", size: 1, kind: "image" }]
  };
  const cleaned = prepareForSummarization(msg);
  assert.match(cleaned.content, /real question/);
  assert.match(cleaned.content, /\[image\]/);
  assert.equal(cleaned.reasoningContent, undefined);
  assert.equal(cleaned.attachments?.length, 0);
});

test("truncateTrailingIncompleteToolCall drops dangling assistant tool_call", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "do something" },
    { role: "assistant", content: "calling tool", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] }
  ];
  const result = truncateTrailingIncompleteToolCall(messages);
  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});

test("truncateTrailingIncompleteToolCall keeps paired tool_call + result", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "read it" },
    { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
    { role: "tool", toolCallId: "c1", content: "file content" }
  ];
  const result = truncateTrailingIncompleteToolCall(messages);
  assert.equal(result.length, 3);
});

test("truncateTrailingIncompleteToolCall strips consecutive dangling calls", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "1", toolCalls: [{ id: "c1", name: "a", arguments: {} }] },
    { role: "assistant", content: "2", toolCalls: [{ id: "c2", name: "b", arguments: {} }] }
  ];
  const result = truncateTrailingIncompleteToolCall(messages);
  assert.equal(result.length, 1);
});
