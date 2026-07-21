/**
 * 单一来源的 token 估算与上下文预算工具。
 *
 * 借鉴 xai-org/grok-build 的 `xai-token-estimation` crate:
 * 所有需要把字节换算成 token、计算上下文使用率、判断是否触发压缩的位置,
 * 都必须从这里 import,避免在代码里到处重复 `/ 4` 硬编码。
 *
 * 本模块只包含纯函数,不依赖 I/O 或配置,方便在 server / providers / tools
 * 任意层安全使用。
 */

/** 每 token 大致对应的字节数(粗粒度启发式)。 */
export const BYTES_PER_TOKEN = 4;

/** 单张图片在 prompt 中的近似 token 成本(低分辨率 patch 求和)。 */
export const IMAGE_TOKEN_ESTIMATE = 765;

/** 文件附件(非图片)的近似 token 成本。 */
export const FILE_TOKEN_ESTIMATE = 1_200;

/** 单条消息除正文外的固定 token 开销(role、tool_call 元数据等)。 */
export const MESSAGE_OVERHEAD_TOKENS = 8;

/** 字符串的 bytes/4 token 估算。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN);
}

/** token 预算反推字符预算(用于按预算裁剪文本)。 */
export function estimateChars(tokens: number): number {
  return Math.max(0, tokens * BYTES_PER_TOKEN);
}

/** `imageCount` 张图片的近似 token 成本。 */
export function estimateImageTokens(imageCount: number): number {
  return Math.max(0, imageCount) * IMAGE_TOKEN_ESTIMATE;
}

/** 上下文使用率,返回值 clamp 到 [0, 100]。total 为 0 时返回 0。 */
export function usagePercentage(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, (used / total) * 100);
}

/** 整数形式的使用率(四舍五入),clamp 到 [0, 100]。 */
export function usagePercentageInt(used: number, total: number): number {
  return Math.round(usagePercentage(used, total));
}

/** 剩余可用 token,饱和到 0。 */
export function freeTokens(total: number, used: number): number {
  return Math.max(0, total - used);
}

/**
 * 是否达到压缩阈值(整数语义,与 grok-build 的 `exceeds_threshold` 对齐)。
 * contextWindow 为 0 时永远返回 false,避免调用方特判。
 */
export function exceedsThreshold(used: number, contextWindow: number, thresholdPercent: number): boolean {
  if (contextWindow <= 0) return false;
  return used * 100 >= contextWindow * thresholdPercent;
}

/**
 * 与 `exceedsThreshold` 类似,但预留 headroom 个 token 的安全边距。
 * 用于"提前触发压缩"——避免刚好用完上下文导致下一次请求 400。
 */
export function exceedsThresholdWithHeadroom(
  used: number,
  contextWindow: number,
  thresholdPercent: number,
  headroom: number
): boolean {
  if (contextWindow <= 0) return false;
  return used * 100 >= contextWindow * thresholdPercent - headroom * 100;
}
