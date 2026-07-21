import assert from "node:assert/strict";
import test from "node:test";

test("long-term memories deduplicate, rank by query, expire, and reject credentials", async () => {
  process.env.LOCAL_DATABASE_PATH = `/tmp/rcode-memory-db-${process.pid}-${Date.now()}.sqlite`;
  const { listMemories, saveMemory, searchMemories } = await import("./database");
  const projectPath = `/tmp/rcode-memory-project-${process.pid}-${Date.now()}`;

  const preferenceId = saveMemory(projectPath, "preference", "Use pnpm for this project", 4, { source: "skill" });
  const duplicateId = saveMemory(projectPath, "preference", "Use pnpm for this project", 2, { source: "manual" });
  saveMemory(projectPath, "decision", "The API uses REST endpoints", 5, { source: "manual" });
  saveMemory(projectPath, "note", "Temporary note", 5, { expiresAt: new Date(Date.now() - 1_000).toISOString() });

  assert.equal(duplicateId, preferenceId);
  assert.equal(listMemories(projectPath, 20).length, 2);
  const results = searchMemories(projectPath, "Which package manager should I use? pnpm", 5);
  assert.equal(results[0]?.id, preferenceId);
  assert.match(results[0]?.content ?? "", /pnpm/);
  assert.throws(
    () => saveMemory(projectPath, "note", "api_key = should-not-be-stored", 1),
    /cannot contain credentials/i
  );
});

test("memory settings are normalized to safe bounds", async () => {
  const { normalizeMemorySettings } = await import("../agent/memory");
  const settings = normalizeMemorySettings({
    shortTerm: { enabled: false, contextBudgetTokens: 2, summaryTokenLimit: 99_999 },
    longTerm: { maxResults: 500, minImportance: -1, retrieval: "unknown" },
    skillIntegration: { exposeTools: false }
  });

  assert.equal(settings.shortTerm.enabled, false);
  assert.equal(settings.shortTerm.contextBudgetTokens, 4_000);
  assert.equal(settings.shortTerm.summaryTokenLimit, 8_000);
  assert.equal(settings.longTerm.maxResults, 50);
  assert.equal(settings.longTerm.minImportance, 1);
  assert.equal(settings.longTerm.retrieval, "hybrid");
  assert.equal(settings.skillIntegration.exposeTools, false);
});
