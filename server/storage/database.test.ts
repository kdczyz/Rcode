import assert from "node:assert/strict";
import test from "node:test";

test("learning records are deduplicated, updated, and reject credentials", async () => {
  process.env.LOCAL_DATABASE_PATH = `/tmp/rcode-learning-db-${process.pid}-${Date.now()}.sqlite`;
  const {
    deleteLearningRecord,
    getAgentUsageSummary,
    listLearningRecords,
    recordAgentUsageEvent,
    saveLearningRecord
  } = await import("./database");
  const projectPath = `/tmp/rcode-learning-${process.pid}-${Date.now()}`;
  const first = saveLearningRecord({
    projectPath,
    title: "Use the project formatter",
    insight: "Run the repository formatter after editing TypeScript files.",
    category: "workflow",
    evidence: "The formatting check passed after running it.",
    importance: 2,
    dedupeKey: "workflow-project-formatter",
    source: "automatic",
    confidence: 0.9
  });
  const duplicate = saveLearningRecord({
    projectPath,
    title: "Run formatting after TypeScript edits",
    insight: "After TypeScript changes, run the repository formatter and verify the formatting check.",
    category: "workflow",
    evidence: "Verified in the build.",
    importance: 4,
    dedupeKey: "workflow-project-formatter",
    source: "automatic",
    confidence: 0.95
  });

  try {
    assert.equal(duplicate.id, first.id);
    const records = listLearningRecords(projectPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].importance, 4);
    assert.equal(records[0].evidence, "Verified in the build.");
    assert.equal(records[0].confirmationCount, 2);
    assert.throws(() => saveLearningRecord({
      projectPath,
      title: "Credential",
      insight: "api_key = secret-value-that-must-not-be-saved",
      category: "project"
    }), /cannot contain credentials/i);

    recordAgentUsageEvent({
      eventType: "ai_call",
      model: "usage-test",
      provider: "provider-usage",
      rawInputTokens: 100,
      promptTokens: 20,
      completionTokens: 7,
      totalTokens: 107,
      cacheReadTokens: 80,
      cacheCreationTokens: 0
    });
    const usage = getAgentUsageSummary();
    assert.equal(usage.recent[0].rawInputTokens, 100);
    assert.equal(usage.recent[0].promptTokens, 20);
    assert.equal(usage.totals.realTotalTokens, 107);
    assert.equal(usage.totals.cacheHitRate, 0.8);
  } finally {
    deleteLearningRecord(first.id);
  }
});
