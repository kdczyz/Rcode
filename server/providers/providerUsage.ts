export interface ProviderUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface NormalizedProviderUsage {
  /** Provider-reported input. OpenAI-compatible protocols include cache buckets here. */
  rawInputTokens: number;
  /** Newly processed input after cache read/write buckets are removed. */
  inputTokens: number;
  outputTokens: number;
  /** Cache-normalized total: fresh input + output + cache read + cache creation. */
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function safeTokenCount(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

/** Normalize OpenAI Chat Completions and Responses-style usage payloads. */
export function normalizeProviderUsage(usage: ProviderUsagePayload): NormalizedProviderUsage {
  const rawInputTokens = safeTokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = safeTokenCount(usage.completion_tokens ?? usage.output_tokens);
  const cacheReadTokens = safeTokenCount(
    usage.cache_read_input_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens
  );
  const cacheCreationTokens = safeTokenCount(
    usage.cache_creation_input_tokens ??
    usage.input_tokens_details?.cache_write_tokens ??
    usage.prompt_tokens_details?.cache_write_tokens
  );
  const cacheTokens = cacheReadTokens + cacheCreationTokens;
  // Match CC Switch's defensive normalization: malformed providers that report
  // cache buckets larger than total input keep their raw input instead of
  // producing a negative fresh-input value.
  const inputTokens = rawInputTokens >= cacheTokens
    ? rawInputTokens - cacheTokens
    : rawInputTokens;

  return {
    rawInputTokens,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens
  };
}

export function hasBillableProviderUsage(usage: NormalizedProviderUsage) {
  return usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0;
}

export function deriveCacheHitRate(usage: Pick<NormalizedProviderUsage, "inputTokens" | "cacheReadTokens" | "cacheCreationTokens">) {
  const cacheableInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return cacheableInput > 0 ? usage.cacheReadTokens / cacheableInput : 0;
}
