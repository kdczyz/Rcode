import assert from "node:assert/strict";
import test from "node:test";
import { deriveCacheHitRate, hasBillableProviderUsage, normalizeProviderUsage } from "./providerUsage";

test("normalizes OpenAI chat usage and cache buckets", () => {
  const usage = normalizeProviderUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 }
  });

  assert.deepEqual(usage, {
    rawInputTokens: 120,
    inputTokens: 30,
    outputTokens: 30,
    totalTokens: 150,
    cacheReadTokens: 80,
    cacheCreationTokens: 10
  });
  assert.equal(hasBillableProviderUsage(usage), true);
  assert.equal(deriveCacheHitRate(usage), 2 / 3);
});

test("normalizes Responses usage and rejects synthetic all-zero usage", () => {
  assert.deepEqual(normalizeProviderUsage({
    input_tokens: 25,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 12 }
  }), {
    rawInputTokens: 25,
    inputTokens: 13,
    outputTokens: 5,
    totalTokens: 30,
    cacheReadTokens: 12,
    cacheCreationTokens: 0
  });

  assert.equal(hasBillableProviderUsage(normalizeProviderUsage({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  })), false);
});

test("keeps malformed cache-inclusive input non-negative", () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: 10,
    completion_tokens: 2,
    prompt_tokens_details: { cached_tokens: 20 }
  }), {
    rawInputTokens: 10,
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 32,
    cacheReadTokens: 20,
    cacheCreationTokens: 0
  });
});
