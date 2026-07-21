/**
 * 压缩 / 摘要前的消息净化工具。
 *
 * 借鉴 xai-org/grok-build `xai-chat-state::compaction_utils`:
 * - strip_system_tags    去掉 <user_info> / <project_layout> / <git_status> 等系统注入的元数据块
 * - strip_reasoning      去掉 reasoning_content / reasoning_details(避免签名 thinking 块失效 + 节省 token)
 * - strip_images         把 image 附件替换为 "[image]" 占位,避免摘要器收到 base64 大对象
 * - prepare_for_summarization  三者组合,产出"干净的纯文本意图"供摘要 / segment 存储使用
 * - truncate_trailing_incomplete_tool_call  丢弃末尾 dangling tool_call,避免严格后端 400
 *
 * 全部纯函数,只做数据变换,不做 I/O。
 */

import type { AgentMessage } from "../shared/types";

/**
 * 需要从 user / system 文本中剥离的 system-tag 白名单。
 * 这些 tag 通常由 runtime 注入,不属于"用户真实意图"。
 * 与 grok-build 的 SYSTEM_TAGS 对齐,并按 Rcode 实际注入点补充。
 */
const SYSTEM_TAGS: readonly string[] = [
  "user_info",
  "project_layout",
  "git_status",
  "fork-context",
  "system-reminder",
  "system_reminder",
  "agent-memory",
  "background_context",
  "command-name",
  "command-message",
  "command-args",
  "memory-context"
];

/**
 * 从 text 中移除所有 `<tag>...</tag>` 形式的 system-tag 块。
 * 未闭合的 tag 保留原样(避免误伤用户真实输入)。
 */
export function stripSystemTags(text: string): string {
  let result = text;
  for (const tag of SYSTEM_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    let cursor = 0;
    while (true) {
      const start = result.indexOf(open, cursor);
      if (start < 0) break;
      const endRel = result.indexOf(close, start + open.length);
      if (endRel < 0) break; // 未闭合,放弃该 tag 后续匹配
      const end = endRel + close.length;
      result = result.slice(0, start) + result.slice(end);
      cursor = start; // 从原位置继续,处理嵌套/相邻情况
    }
  }
  return result.trim();
}

/**
 * 提取 user_query 内容。如果消息里有 `<user_query>...</user_query>`,
 * 返回其内部文本(并剥离 system tag);否则返回剥离 system tag 后的整体文本。
 */
export function extractUserQuery(text: string): string {
  const open = "<user_query>";
  const close = "</user_query>";
  const start = text.indexOf(open);
  if (start >= 0) {
    const contentStart = start + open.length;
    const endRel = text.indexOf(close, contentStart);
    if (endRel >= 0) {
      return stripSystemTags(text.slice(contentStart, endRel));
    }
  }
  return stripSystemTags(text);
}

/** 找到最后一条真实 user 消息的有效 query(剥掉 metadata)。 */
export function extractLastUserQuery(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const q = extractUserQuery(msg.content);
    if (q) return q;
  }
  return undefined;
}

/**
 * 剥离 reasoning 字段。
 *
 * 两个目的:
 * 1. 节省摘要器输入 token(reasoning 往往比正文还长)。
 * 2. 避免压缩后改写了 content,导致严格后端校验签名 thinking 块失败。
 *
 * 返回新对象,原消息不被修改。
 */
export function stripReasoning(message: AgentMessage): AgentMessage {
  if (!message.reasoningContent && !message.reasoningDetails) return message;
  const next: AgentMessage = { ...message };
  delete next.reasoningContent;
  delete next.reasoningDetails;
  return next;
}

/**
 * 把消息中的 image 附件替换为 "[image]" 文本占位。
 * 附件里的 file 类资源仍保留(它们是必要的命名引用,体积小)。
 */
export function stripImages(message: AgentMessage): AgentMessage {
  if (!message.attachments || message.attachments.length === 0) return message;
  const hasImage = message.attachments.some((a) => a.kind === "image");
  if (!hasImage) return message;
  const next: AgentMessage = {
    ...message,
    attachments: message.attachments.filter((a) => a.kind !== "image")
  };
  // 在原 content 末尾追加占位,便于摘要器知道这里曾经有过图。
  const imageCount = message.attachments.filter((a) => a.kind === "image").length;
  const placeholder = imageCount === 1 ? "[image]" : `[image x${imageCount}]`;
  next.content = next.content ? `${next.content}\n${placeholder}` : placeholder;
  return next;
}

/**
 * 组合:剥离 system tag + reasoning + image。
 * 用于把消息喂给摘要器 / segment 存储前的最终清洗。
 */
export function prepareForSummarization(message: AgentMessage): AgentMessage {
  const noImages = stripImages(message);
  const noReasoning = stripReasoning(noImages);
  if (noReasoning.role === "user" || noReasoning.role === "system") {
    return { ...noReasoning, content: stripSystemTags(noReasoning.content) };
  }
  return noReasoning;
}

/**
 * 丢弃末尾 dangling tool_call:
 * 如果最后一条 assistant 消息带了 tool_calls 但后面没有匹配的 tool result,
 * 直接整条丢弃。严格后端(OpenAI、Anthropic 等)会因 tool_use 不配对而 400。
 *
 * 返回新数组,输入数组不变。
 */
export function truncateTrailingIncompleteToolCall(messages: AgentMessage[]): AgentMessage[] {
  const result = [...messages];
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) {
      result.pop();
      continue;
    }
    break;
  }
  return result;
}
