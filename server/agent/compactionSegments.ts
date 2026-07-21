/**
 * 分级压缩模式 CompactionMode + 段落存储(segment store)。
 *
 * 借鉴 xai-org/grok-build `xai-chat-state::compaction_mode` 与 `compaction_transcript`:
 *
 *   Summary     只保留摘要,被压缩的内容彻底丢弃(Rcode 现状)。
 *   Transcript  摘要 + 在摘要末尾附上完整原始 transcript 的文件路径,
 *               模型发现摘要不够时可自行 read_file 回看。
 *   Segments    摘要 + 把被省略的消息按"段"渲染成独立 markdown 文件
 *               落到 `<workspace>/.agent/compaction/segment_NNN.md`,
 *               附带 INDEX.md 目录;模型可以 grep / read_file 精准回查。
 *
 * 默认 Summary,保持现状;当模型上下文长任务反复需要回溯时,可切换到
 * Transcript 或 Segments。
 */

import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../shared/types";
import { prepareForSummarization } from "./contextStrip";

/** 段落存储目录名(相对 workspace 根)。 */
export const COMPACTION_DIR = path.join(".agent", "compaction");
/** 索引文件名。 */
export const INDEX_FILE = "INDEX.md";
/** 单个 segment 文件前缀。 */
const SEGMENT_PREFIX = "segment_";
/** 单 segment 大小上限(超出后按轮次截断,旧轮次丢弃)。 */
const SEGMENT_MAX_BYTES = 512 * 1024;
/** 每轮在 markdown 中的固定开销估计。 */
const PER_TURN_OVERHEAD_BYTES = 64;

/** INDEX.md 表头(首次创建时写入)。 */
export const INDEX_HEADER =
  "# Compaction Segment Index\n\n" +
  "| Segment | File | Turns | Approx bytes | Keywords |\n" +
  "|---|---|---|---|---|\n";

/**
 * 压缩后模型能看到多少"找回细节的通道"。
 *
 *  - summary     只有摘要,无回查通道(默认,最省 token)
 *  - transcript  摘要 + 完整 jsonl transcript 路径
 *  - segments    摘要 + compaction/segment_NNN.md + INDEX.md
 */
export type CompactionMode = "summary" | "transcript" | "segments";

/** segments 模式下每个 segment 文件保留多少 verbatim 细节。 */
export type CompactionDetail = "none" | "minimal" | "balanced" | "verbose";

export const DEFAULT_COMPACTION_DETAIL: CompactionDetail = "balanced";

/**
 * 构造追加到摘要末尾的"回查提示"。
 * summary 模式返回空字符串,其他模式返回一段指引模型如何回查的文本。
 */
export function buildTranscriptHint(mode: CompactionMode, location?: string): string {
  if (mode === "summary" || !location) return "";
  if (mode === "transcript") {
    return (
      `\n\nIf you need specific details from before compaction ` +
      `(exact code snippets, error messages, file contents you generated), ` +
      `read the full transcript at: ${location}`
    );
  }
  // segments
  return (
    `\n\nFull verbatim rollouts of previous segments are available at ` +
    `${location}/${SEGMENT_PREFIX}*.md. See ${location}/${INDEX_FILE} for a table of contents. ` +
    `Use read_file or search_text to recover specific details (exact code, file paths, tool outputs) ` +
    `if this summary is insufficient. Do NOT modify these files.`
  );
}

/** segment 文件名,如 segment_007.md。 */
export function segmentFilename(index: number): string {
  return `${SEGMENT_PREFIX}${String(index).padStart(3, "0")}.md`;
}

/** 从 segment_NNN.md 文件名解析出 N,不匹配返回 undefined。 */
export function parseSegmentIndex(filename: string): number | undefined {
  if (!filename.startsWith(SEGMENT_PREFIX) || !filename.endsWith(".md")) return undefined;
  const n = Number.parseInt(filename.slice(SEGMENT_PREFIX.length, -3), 10);
  return Number.isFinite(n) ? n : undefined;
}

function roleLabel(message: AgentMessage): string {
  switch (message.role) {
    case "system": return "System";
    case "user": return "Human";
    case "assistant": return "Assistant";
    case "tool": return "Function";
  }
}

/** 从消息集合中提取高频关键词,用于 INDEX.md 快速检索。 */
function extractKeywords(messages: AgentMessage[], maxKeywords = 8): string[] {
  const freq = new Map<string, number>();
  for (const msg of messages) {
    const text = `${msg.content} ${(msg.toolCalls ?? []).map((t) => t.name).join(" ")}`;
    const words = text.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (["this", "that", "with", "from", "have", "been", "will", "would", "should"].includes(lower)) continue;
      freq.set(lower, (freq.get(lower) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

/**
 * 把一组消息按 detail level 渲染成 markdown 段。
 * 输入消息应已通过 prepareForSummarization 清洗。
 */
export function renderSegmentMarkdown(
  segmentIndex: number,
  messages: AgentMessage[],
  detail: CompactionDetail
): string {
  if (detail === "none" || messages.length === 0) return "";

  const lines: string[] = [`# Segment ${String(segmentIndex).padStart(3, "0")}`, ""];
  let bytes = lines[0].length + 1;
  let truncated = false;
  let omittedTurns = 0;

  for (const msg of messages) {
    if (bytes > SEGMENT_MAX_BYTES) {
      truncated = true;
      omittedTurns += 1;
      continue;
    }
    const role = roleLabel(msg);
    const toolNames = (msg.toolCalls ?? []).map((t) => t.name).join(", ");
    let body: string;
    if (detail === "minimal") {
      const preview = msg.content.replace(/\s+/g, " ").trim().slice(0, 120);
      body = toolNames ? `[tools: ${toolNames}] ${preview}` : preview;
    } else if (detail === "balanced") {
      const text = msg.content.slice(0, 2_000);
      const suffix = msg.content.length > 2_000 ? "\n[... truncated ...]" : "";
      body = toolNames ? `[Called tools: ${toolNames}]\n\n${text}${suffix}` : `${text}${suffix}`;
    } else {
      // verbose
      body = toolNames ? `[Called tools: ${toolNames}]\n\n${msg.content}` : msg.content;
    }
    const section = `## ${role}\n\n${body}\n`;
    lines.push(section);
    bytes += section.length + PER_TURN_OVERHEAD_BYTES;
  }

  if (truncated) {
    lines.push(
      `\n[... TRUNCATED at ${SEGMENT_MAX_BYTES} bytes, ${omittedTurns} turns omitted ...]\n`
    );
  }
  return lines.join("\n");
}

/**
 * 把一段被压缩的消息写入 segment store,并维护 INDEX.md。
 *
 * @returns 写入的 segment 文件绝对路径;detail=none 或消息为空时返回 undefined。
 */
export async function writeSegment(
  workspaceRoot: string,
  segmentIndex: number,
  messages: AgentMessage[],
  detail: CompactionDetail = DEFAULT_COMPACTION_DETAIL
): Promise<string | undefined> {
  const cleaned = messages.map(prepareForSummarization);
  const markdown = renderSegmentMarkdown(segmentIndex, cleaned, detail);
  if (!markdown) return undefined;

  const dir = path.join(workspaceRoot, COMPACTION_DIR);
  await mkdir(dir, { recursive: true });

  const filename = segmentFilename(segmentIndex);
  const filePath = path.join(dir, filename);
  await writeFile(filePath, markdown, "utf8");

  const indexPath = path.join(dir, INDEX_FILE);
  if (!existsSync(indexPath)) {
    await writeFile(indexPath, INDEX_HEADER, "utf8");
  }
  const keywords = extractKeywords(cleaned).join(", ");
  const approx = Buffer.byteLength(markdown, "utf8");
  const row = `| ${segmentIndex} | ${filename} | ${messages.length} | ${approx} | ${keywords} |\n`;
  await appendFile(indexPath, row, "utf8");

  return filePath;
}

/** 读取当前 workspace 的 segment store 路径(若不存在则返回 undefined)。 */
export function getCompactionStorePath(workspaceRoot: string): string | undefined {
  const dir = path.join(workspaceRoot, COMPACTION_DIR);
  return existsSync(dir) ? dir : undefined;
}

/** 读取 INDEX.md 内容(不存在时返回空字符串)。 */
export async function readCompactionIndex(workspaceRoot: string): Promise<string> {
  const indexPath = path.join(workspaceRoot, COMPACTION_DIR, INDEX_FILE);
  if (!existsSync(indexPath)) return "";
  return readFile(indexPath, "utf8");
}
