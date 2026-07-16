import assert from "node:assert/strict";
import test from "node:test";
import { hasBillableProviderUsage, normalizeProviderUsage } from "./providerUsage";

test("normalizes OpenAI chat usage and cache buckets", () => {
  const usage = normalizeProviderUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 }
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    cacheReadTokens: 80,
    cacheCreationTokens: 10
  });
  assert.equal(hasBillableProviderUsage(usage), true);
});

test("normalizes Responses usage and rejects synthetic all-zero usage", () => {
  assert.deepEqual(normalizeProviderUsage({
    input_tokens: 25,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 12 }
  }), {
    inputTokens: 25,
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
