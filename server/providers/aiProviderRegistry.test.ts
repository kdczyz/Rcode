import assert from "node:assert/strict";
import test from "node:test";
import { inferImageModels, normalizeAiProviderInput, normalizeProviderBalanceResponse } from "./aiProviderRegistry";

test("detects image models and assigns them to the image capability", () => {
  assert.deepEqual(inferImageModels([
    "gpt-5.4",
    "gpt-image-1.5",
    "gpt-image-2",
    "black-forest-labs/flux-1.1-pro"
  ]), ["gpt-image-1.5", "gpt-image-2", "black-forest-labs/flux-1.1-pro"]);

  const provider = normalizeAiProviderInput({
    id: "test",
    displayName: "Test",
    baseUrl: "https://api.example.com/v1",
    defaultModel: "gpt-5.4",
    fallbackModels: ["gpt-5.4-mini", "gpt-image-2"]
  });
  assert.equal(provider.defaultImageModel, "gpt-image-2");
  assert.deepEqual(provider.imageModels, ["gpt-image-2"]);
});

test("normalizes DeepSeek multi-currency balance responses", () => {
  assert.deepEqual(normalizeProviderBalanceResponse({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10", topped_up_balance: "100" }
    ]
  }), {
    status: "available",
    balances: [{ currency: "CNY", amount: 110, grantedAmount: 10, toppedUpAmount: 100 }]
  });
});

test("normalizes OpenRouter key limits and unlimited keys", () => {
  assert.deepEqual(normalizeProviderBalanceResponse({ data: { limit_remaining: 8.25, usage: 1.75 } }), {
    status: "available",
    balances: [{ currency: "USD", amount: 8.25 }]
  });
  assert.deepEqual(normalizeProviderBalanceResponse({ data: { limit: null, limit_remaining: null } }), {
    status: "unlimited"
  });
});

test("derives remaining credits and accepts common custom balance fields", () => {
  assert.deepEqual(normalizeProviderBalanceResponse({ data: { total_credits: 20, total_usage: 3.5 } }), {
    status: "available",
    balances: [{ currency: "USD", amount: 16.5 }]
  });
  assert.deepEqual(normalizeProviderBalanceResponse({ data: { currency: "CNY", available_balance: "6.80" } }), {
    status: "available",
    balances: [{ currency: "CNY", amount: 6.8 }]
  });
});

test("rejects responses that do not contain a recognizable balance", () => {
  assert.equal(normalizeProviderBalanceResponse({ data: { ok: true } }), undefined);
});
