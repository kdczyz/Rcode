import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTranscriptHint,
  COMPACTION_DIR,
  INDEX_FILE,
  INDEX_HEADER,
  parseSegmentIndex,
  readCompactionIndex,
  renderSegmentMarkdown,
  segmentFilename,
  writeSegment
} from "./compactionSegments";
import type { AgentMessage } from "../shared/types";

test("segmentFilename pads index to 3 digits", () => {
  assert.equal(segmentFilename(1), "segment_001.md");
  assert.equal(segmentFilename(7), "segment_007.md");
  assert.equal(segmentFilename(42), "segment_042.md");
  assert.equal(segmentFilename(123), "segment_123.md");
});

test("parseSegmentIndex round-trips valid names", () => {
  assert.equal(parseSegmentIndex("segment_001.md"), 1);
  assert.equal(parseSegmentIndex("segment_042.md"), 42);
  assert.equal(parseSegmentIndex("segment_123.md"), 123);
});

test("parseSegmentIndex rejects non-matching names", () => {
  assert.equal(parseSegmentIndex("INDEX.md"), undefined);
  assert.equal(parseSegmentIndex("segment_.md"), undefined);
  assert.equal(parseSegmentIndex("segment_abc.md"), undefined);
  assert.equal(parseSegmentIndex("other_001.md"), undefined);
});

test("buildTranscriptHint summary returns empty", () => {
  assert.equal(buildTranscriptHint("summary", "/some/path"), "");
  assert.equal(buildTranscriptHint("summary"), "");
});

test("buildTranscriptHint transcript points at raw transcript", () => {
  const hint = buildTranscriptHint("transcript", "/ws/.agent/compaction");
  assert.match(hint, /\/ws\/\.agent\/compaction/);
  assert.match(hint, /read the full transcript/);
});

test("buildTranscriptHint segments points at segment_NNN and INDEX", () => {
  const hint = buildTranscriptHint("segments", "/ws/.agent/compaction");
  assert.match(hint, /segment_\*\.md/);
  assert.match(hint, /INDEX\.md/);
  assert.match(hint, /read_file or search_text/);
});

test("buildTranscriptHint requires location", () => {
  assert.equal(buildTranscriptHint("transcript"), "");
  assert.equal(buildTranscriptHint("segments", undefined), "");
});

test("renderSegmentMarkdown minimal detail gives one-liner per turn", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "question one about something" },
    { role: "assistant", content: "answer", toolCalls: [{ id: "c", name: "read_file", arguments: {} }] }
  ];
  const md = renderSegmentMarkdown(1, messages, "minimal");
  assert.match(md, /# Segment 001/);
  assert.match(md, /## Human/);
  assert.match(md, /## Assistant/);
  assert.match(md, /tools: read_file/);
});

test("renderSegmentMarkdown verbose keeps full content", () => {
  const longContent = "x".repeat(5_000);
  const messages: AgentMessage[] = [{ role: "user", content: longContent }];
  const md = renderSegmentMarkdown(2, messages, "verbose");
  assert.ok(md.includes(longContent));
});

test("renderSegmentMarkdown balanced truncates long text", () => {
  const longContent = "x".repeat(10_000);
  const messages: AgentMessage[] = [{ role: "user", content: longContent }];
  const md = renderSegmentMarkdown(3, messages, "balanced");
  assert.ok(md.length < longContent.length + 200);
  assert.match(md, /truncated/);
});

test("renderSegmentMarkdown none returns empty", () => {
  const md = renderSegmentMarkdown(1, [{ role: "user", content: "hi" }], "none");
  assert.equal(md, "");
});

test("writeSegment creates segment file and INDEX", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rcode-seg-"));
  try {
    const messages: AgentMessage[] = [
      { role: "user", content: "test question about tokens and context" },
      { role: "assistant", content: "test answer about tokens" }
    ];
    const filePath = await writeSegment(dir, 5, messages, "balanced");
    assert.ok(filePath);
    assert.equal(path.basename(filePath!), "segment_005.md");

    // segment 文件存在且非空
    const content = await readFile(filePath!, "utf8");
    assert.match(content, /# Segment 005/);
    assert.match(content, /test question/);

    // INDEX.md 被创建,且包含表头 + 一行数据
    const indexPath = path.join(dir, COMPACTION_DIR, INDEX_FILE);
    const index = await readFile(indexPath, "utf8");
    assert.ok(index.startsWith(INDEX_HEADER));
    assert.match(index, /\| 5 \| segment_005\.md \| 2 \|/);
    // 关键词列包含 "tokens" 或 "context"
    assert.match(index, /tokens|context/);

    // 再写一段,INDEX 应该追加而不是覆盖
    await writeSegment(dir, 6, messages, "balanced");
    const index2 = await readFile(indexPath, "utf8");
    assert.match(index2, /segment_005\.md/);
    assert.match(index2, /segment_006\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeSegment strips system tags from content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rcode-seg-"));
  try {
    const messages: AgentMessage[] = [
      { role: "user", content: "<user_info>OS darwin</user_info>real question" }
    ];
    const filePath = await writeSegment(dir, 1, messages, "verbose");
    const content = await readFile(filePath!, "utf8");
    assert.match(content, /real question/);
    assert.ok(!content.includes("user_info"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeSegment none detail returns undefined", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rcode-seg-"));
  try {
    const result = await writeSegment(dir, 1, [{ role: "user", content: "hi" }], "none");
    assert.equal(result, undefined);
    // 不应该创建任何文件
    const files = await readdir(dir);
    assert.equal(files.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCompactionIndex returns empty string when no index exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rcode-seg-"));
  try {
    assert.equal(await readCompactionIndex(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
