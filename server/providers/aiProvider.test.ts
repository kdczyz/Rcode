import assert from "node:assert/strict";
import test from "node:test";
import { buildReasoningRequestConfig } from "./aiProvider";

test("maps MiMo thinking modes to the native thinking toggle", () => {
  assert.deepEqual(
    buildReasoningRequestConfig("https://api.xiaomimimo.com/v1", "mimo-v2.5", "fast").parameters,
    { thinking: { type: "disabled" } }
  );
  assert.deepEqual(
    buildReasoningRequestConfig("https://api.xiaomimimo.com/v1", "mimo-v2.5-pro", "deep").parameters,
    { thinking: { type: "enabled" } }
  );
});

test("maps DeepSeek modes to toggle and supported effort values", () => {
  assert.deepEqual(
    buildReasoningRequestConfig("https://api.deepseek.com", "deepseek-v4-pro", "fast").parameters,
    { thinking: { type: "disabled" } }
  );
  assert.deepEqual(
    buildReasoningRequestConfig("https://api.deepseek.com", "deepseek-v4-pro", "balanced").parameters,
    { thinking: { type: "enabled" }, reasoning_effort: "high" }
  );
  assert.deepEqual(
    buildReasoningRequestConfig("https://api.deepseek.com", "deepseek-v4-pro", "deep").parameters,
    { thinking: { type: "enabled" }, reasoning_effort: "max" }
  );
});

test("maps OpenAI-compatible modes to reasoning_effort", () => {
  const baseUrl = "https://api.openai.com/v1";
  assert.equal(buildReasoningRequestConfig(baseUrl, "gpt-5", "fast").parameters.reasoning_effort, "low");
  assert.equal(buildReasoningRequestConfig(baseUrl, "gpt-5", "balanced").parameters.reasoning_effort, "medium");
  assert.equal(buildReasoningRequestConfig(baseUrl, "gpt-5", "deep").parameters.reasoning_effort, "high");
});

test("maps GLM 5.2 modes to thinking and reasoning effort", () => {
  const baseUrl = "https://open.bigmodel.cn/api/paas/v4";
  assert.deepEqual(buildReasoningRequestConfig(baseUrl, "glm-5.2", "fast").parameters, {
    thinking: { type: "disabled" }
  });
  assert.deepEqual(buildReasoningRequestConfig(baseUrl, "glm-5.2", "balanced").parameters, {
    thinking: { type: "enabled" },
    reasoning_effort: "medium"
  });
  const deep = buildReasoningRequestConfig(baseUrl, "glm-5.2", "deep");
  assert.deepEqual(deep.parameters, {
    thinking: { type: "enabled", clear_thinking: false },
    reasoning_effort: "max"
  });
  assert.equal(deep.replay, "all");
});

test("keeps older GLM models on their supported thinking toggle", () => {
  const config = buildReasoningRequestConfig("https://open.bigmodel.cn/api/paas/v4", "glm-4.7", "deep");
  assert.deepEqual(config.parameters, { thinking: { type: "enabled", clear_thinking: false } });
  assert.equal(config.applied.method, "thinking_toggle");
  assert.equal(config.replay, "all");
});

test("maps Kimi model generations without sending unsupported temperature", () => {
  const baseUrl = "https://api.moonshot.cn/v1";
  assert.deepEqual(buildReasoningRequestConfig(baseUrl, "kimi-k2.6", "fast").parameters, {
    thinking: { type: "disabled" }
  });

  const k26Deep = buildReasoningRequestConfig(baseUrl, "kimi-k2.6", "deep");
  assert.deepEqual(k26Deep.parameters, { thinking: { type: "enabled", keep: "all" } });
  assert.deepEqual(k26Deep.omitParameters, ["temperature"]);
  assert.equal(k26Deep.replay, "all");

  const k27Code = buildReasoningRequestConfig(baseUrl, "kimi-k2.7-code", "balanced");
  assert.deepEqual(k27Code.parameters, {});
  assert.equal(k27Code.applied.method, "always_on");
  assert.equal(k27Code.replay, "all");
  assert.deepEqual(k27Code.omitParameters, ["temperature"]);

  const k3 = buildReasoningRequestConfig(baseUrl, "kimi-k3", "deep");
  assert.deepEqual(k3.parameters, { reasoning_effort: "max" });
  assert.equal(k3.replay, "all");
});

test("enables MiniMax reasoning details and structured replay", () => {
  const config = buildReasoningRequestConfig("https://api.minimaxi.com/v1", "MiniMax-M2.7", "deep");
  assert.deepEqual(config.parameters, { reasoning_split: true });
  assert.equal(config.applied.method, "always_on");
  assert.equal(config.replay, "tool_calls");
  assert.equal(config.replayField, "reasoning_details");
});

test("maps DashScope Qwen, DeepSeek, and MiniMax reasoning controls", () => {
  const baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  assert.deepEqual(buildReasoningRequestConfig(baseUrl, "qwen3-max", "fast").parameters, {
    enable_thinking: false
  });
  const qwenDeep = buildReasoningRequestConfig(baseUrl, "qwen3-max", "deep");
  assert.deepEqual(qwenDeep.parameters, {
    enable_thinking: true,
    thinking_budget: 32_768,
    preserve_thinking: true
  });
  assert.equal(qwenDeep.replay, "all");

  assert.deepEqual(buildReasoningRequestConfig(baseUrl, "deepseek-v4", "balanced").parameters, {
    enable_thinking: true,
    reasoning_effort: "high"
  });
  assert.deepEqual(buildReasoningRequestConfig(baseUrl, "minimax-m2.7", "balanced").parameters, {
    thinking: { type: "adaptive" }
  });
});

test("uses OpenRouter's nested reasoning object", () => {
  assert.deepEqual(
    buildReasoningRequestConfig("https://openrouter.ai/api/v1", "openai/gpt-5", "deep").parameters,
    { reasoning: { effort: "high", exclude: false } }
  );
});

test("uses reasoning_effort for Gemini and arbitrary compatible endpoints", () => {
  assert.deepEqual(
    buildReasoningRequestConfig("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3-pro", "balanced").parameters,
    { reasoning_effort: "medium" }
  );
  assert.deepEqual(
    buildReasoningRequestConfig("https://llm.example.com/v1", "custom-reasoner", "deep").parameters,
    { reasoning_effort: "high" }
  );
});

test("uses model-first controls for a Sub2API multi-model gateway", () => {
  const baseUrl = "https://relay.example.com/v1";

  const openAi = buildReasoningRequestConfig(baseUrl, "gpt-5.6-sol", "deep", "sub2api");
  assert.deepEqual(openAi.parameters, { reasoning_effort: "high" });
  assert.equal(openAi.applied.transport, "gateway");

  const glm = buildReasoningRequestConfig(baseUrl, "glm-5.2", "balanced", "sub2api");
  assert.deepEqual(glm.parameters, {
    thinking: { type: "enabled" },
    reasoning_effort: "medium"
  });
  assert.equal(glm.applied.transport, "gateway");

  const kimi = buildReasoningRequestConfig(baseUrl, "kimi-k2.6", "deep", "sub2api");
  assert.deepEqual(kimi.parameters, { thinking: { type: "enabled", keep: "all" } });
  assert.equal(kimi.replay, "all");
  assert.equal(kimi.applied.transport, "gateway");

  const minimax = buildReasoningRequestConfig(baseUrl, "MiniMax-M2.7", "balanced", "sub2api");
  assert.deepEqual(minimax.parameters, { thinking: { type: "adaptive" } });
  assert.equal(minimax.replayField, "reasoning_content");
  assert.equal(minimax.applied.transport, "gateway");

  const qwen = buildReasoningRequestConfig(baseUrl, "qwen3-next-80b-a3b-thinking", "fast", "sub2api");
  assert.deepEqual(qwen.parameters, { thinking: { type: "disabled" } });
  assert.equal(qwen.applied.transport, "gateway");
});

test("auto-detects known Sub2API hosts and honors the standard compatibility override", () => {
  const detected = buildReasoningRequestConfig("https://demo.sub2api.org/v1", "MiniMax-M2.7", "balanced");
  assert.deepEqual(detected.parameters, { thinking: { type: "adaptive" } });
  assert.equal(detected.applied.transport, "gateway");

  const forcedGeneric = buildReasoningRequestConfig(
    "https://relay.example.com/v1",
    "kimi-k2.6",
    "deep",
    "openai-compatible"
  );
  assert.deepEqual(forcedGeneric.parameters, { reasoning_effort: "high" });
  assert.equal(forcedGeneric.applied.transport, "direct");
});
