import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("migrates cache-inclusive legacy input to fresh-input semantics once", async () => {
  const databasePath = `/tmp/rcode-usage-migration-${process.pid}-${Date.now()}.sqlite`;
  process.env.LOCAL_DATABASE_PATH = databasePath;

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE agent_usage_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_path TEXT,
      conversation_id TEXT,
      request_id TEXT,
      model TEXT,
      provider TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      session_was_existing INTEGER
    );
    INSERT INTO agent_usage_events (
      id, created_at, event_type, model, provider,
      prompt_tokens, completion_tokens, total_tokens,
      cached_tokens, cache_read_tokens, cache_creation_tokens
    ) VALUES (
      'legacy-1', '2026-07-17T00:00:00.000Z', 'ai_call', 'gpt-test', 'test-provider',
      100, 10, 110, 80, 80, 0
    );
  `);
  legacy.close();

  try {
    const { getAgentUsageSummary } = await import("./database");
    const first = getAgentUsageSummary();
    const second = getAgentUsageSummary();

    assert.equal(first.totals.rawInputTokens, 100);
    assert.equal(first.totals.promptTokens, 20);
    assert.equal(first.totals.realTotalTokens, 110);
    assert.equal(first.totals.cacheHitRate, 0.8);
    assert.deepEqual(second.totals, first.totals, "migration must not subtract cache twice");
  } finally {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  }
});
