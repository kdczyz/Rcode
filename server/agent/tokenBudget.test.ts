import assert from "node:assert/strict";
import test from "node:test";
import {
  BYTES_PER_TOKEN,
  IMAGE_TOKEN_ESTIMATE,
  estimateChars,
  estimateImageTokens,
  estimateTokens,
  exceedsThreshold,
  exceedsThresholdWithHeadroom,
  freeTokens,
  usagePercentage,
  usagePercentageInt
} from "./tokenBudget";

test("estimateTokens uses bytes/4 heuristic", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("x".repeat(4_000)), 1_000);
  // 向上取整,与原 estimateMessageTokens 行为一致
  assert.equal(estimateTokens("abc"), 1);
});

test("estimateChars is inverse of estimateTokens", () => {
  assert.equal(estimateChars(0), 0);
  assert.equal(estimateChars(1), BYTES_PER_TOKEN);
  assert.equal(estimateChars(1_000), 4_000);
});

test("estimateImageTokens scales linearly", () => {
  assert.equal(estimateImageTokens(0), 0);
  assert.equal(estimateImageTokens(1), IMAGE_TOKEN_ESTIMATE);
  assert.equal(estimateImageTokens(3), 3 * IMAGE_TOKEN_ESTIMATE);
});

test("usagePercentage clamps to [0, 100]", () => {
  assert.equal(usagePercentage(0, 100), 0);
  assert.equal(usagePercentage(50, 100), 50);
  assert.equal(usagePercentage(150, 100), 100);
  assert.equal(usagePercentage(100, 0), 0);
});

test("usagePercentageInt rounds half-up", () => {
  assert.equal(usagePercentageInt(85, 200), 43); // 42.5 -> 43
  assert.equal(usagePercentageInt(7, 8), 88);    // 87.5 -> 88
});

test("freeTokens saturates at 0", () => {
  assert.equal(freeTokens(100, 30), 70);
  assert.equal(freeTokens(100, 100), 0);
  assert.equal(freeTokens(100, 200), 0);
});

test("exceedsThreshold uses integer semantics", () => {
  assert.equal(exceedsThreshold(50, 100, 85), false);
  assert.equal(exceedsThreshold(85, 100, 85), true);
  assert.equal(exceedsThreshold(99, 100, 85), true);
  assert.equal(exceedsThreshold(50, 0, 85), false);
});

test("exceedsThreshold fires exactly at boundary", () => {
  // 850 * 100 === 1000 * 85,必须触发(>= 而非 >)
  assert.equal(exceedsThreshold(850, 1_000, 85), true);
  assert.equal(exceedsThreshold(849, 1_000, 85), false);
});

test("exceedsThresholdWithHeadroom triggers earlier", () => {
  // 100 token headroom 意味着 750 就该触发,而不是 850
  assert.equal(exceedsThresholdWithHeadroom(750, 1_000, 85, 100), true);
  assert.equal(exceedsThresholdWithHeadroom(749, 1_000, 85, 100), false);
});
