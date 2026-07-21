/**
 * 工具结果三段式修剪。
 *
 * 借鉴 xai-org/grok-build `xai-chat-state::types::PruningConfig`:
 * 按"轮次年龄"把 tool 消息分成三段,采用不同修剪策略:
 *
 *   ┌──────────────────────┬────────────────────────────────────────┐
 *   │ 最近 keepLastNTurns  │ 不剪,原样保留(模型可能正在引用)      │
 *   │ 中间段               │ soft trim: 保留 head + tail,中段省略  │
 *   │ 更老(>hardClearAge) │ hard clear: 整体替换为占位符           │
 *   └──────────────────────┴────────────────────────────────────────┘
 *
 * 旧的 Rcode 实现只有一个 `toolOutputTokenLimit` 一刀切,会让近期工具输出
 * 也被截断,影响模型对当前任务的理解;同时老输出仍占据相当空间。三段式
 * 在保真与省 token 之间更平衡。
 */

import type { AgentMessage } from "../shared/types";

export interface ToolResultPruningConfig {
  /** 是否启用。false 时所有消息原样返回。 */
  enabled: boolean;
  /** 最近 N 轮(以 user 消息划分)不修剪任何 tool 结果。 */
  keepLastNTurns: number;
  /** 超过该字符数的 tool 结果才进入 soft trim。 */
  softTrimThresholdChars: number;
  /** soft trim 保留头部字符数。 */
  softTrimHeadChars: number;
  /** soft trim 保留尾部字符数。 */
  softTrimTailChars: number;
  /** 超过该轮次年龄后,直接 hard clear 成占位符。 */
  hardClearAgeTurns: number;
}

export const defaultToolResultPruningConfig: ToolResultPruningConfig = {
  enabled: true,
  keepLastNTurns: 3,
  softTrimThresholdChars: 4_000,
  softTrimHeadChars: 1_500,
  softTrimTailChars: 1_500,
  hardClearAgeTurns: 10
};

const HARD_CLEAR_PLACEHOLDER = "[old tool output cleared to free context space; see audit log if needed]";

/**
 * 把消息数组按 user 消息切分为轮次,返回每条消息所属的"轮次索引"。
 * 返回数组与输入等长;非 user 起始的消息归入第 0 轮。
 */
export function assignTurnIndexes(messages: AgentMessage[]): number[] {
  const indexes: number[] = new Array(messages.length).fill(0);
  let turn = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") turn += 1;
    indexes[i] = Math.max(0, turn);
  }
  return indexes;
}

function softTrim(content: string, head: number, tail: number): string {
  if (content.length <= head + tail + 64) return content;
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n\n[... ${omitted} chars trimmed from middle ...]\n\n${content.slice(-tail)}`;
}

/**
 * 对一组消息应用三段式修剪。
 *
 * @param messages 完整消息数组(通常已经按时间顺序)
 * @param config   修剪配置;缺省使用 defaultToolResultPruningConfig
 * @returns 新消息数组;role 不为 "tool" 的消息原样保留引用
 */
export function pruneToolResults(
  messages: AgentMessage[],
  config: ToolResultPruningConfig = defaultToolResultPruningConfig
): AgentMessage[] {
  if (!config.enabled) return messages;
  if (messages.length === 0) return messages;

  const turnIndexes = assignTurnIndexes(messages);
  const totalTurns = turnIndexes[turnIndexes.length - 1] + 1;

  return messages.map((message, index) => {
    if (message.role !== "tool") return message;
    const turn = turnIndexes[index];
    const age = totalTurns - 1 - turn; // 距离最近一轮的"年龄"

    if (age < config.keepLastNTurns) return message;
    if (age >= config.hardClearAgeTurns) {
      if (message.content === HARD_CLEAR_PLACEHOLDER) return message;
      return { ...message, content: HARD_CLEAR_PLACEHOLDER };
    }
    if (message.content.length > config.softTrimThresholdChars) {
      return {
        ...message,
        content: softTrim(message.content, config.softTrimHeadChars, config.softTrimTailChars)
      };
    }
    return message;
  });
}
