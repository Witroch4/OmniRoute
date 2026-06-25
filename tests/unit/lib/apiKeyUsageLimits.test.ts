import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-usage-limits-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const quotaCache = await import("../../../src/domain/quotaCache.ts");
const quotaResetEvents = await import("../../../src/lib/db/quotaResetEvents.ts");
const usageLimits = await import("../../../src/lib/usage/apiKeyUsageLimits.ts");
const costCalculator = await import("../../../src/lib/usage/costCalculator.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function db() {
  return core.getDbInstance() as unknown as {
    prepare: (sql: string) => {
      get: (...params: unknown[]) => Record<string, unknown> | undefined;
      all: (...params: unknown[]) => Array<Record<string, unknown>>;
      run: (...params: unknown[]) => unknown;
    };
  };
}

function insertUsage(entry: {
  apiKeyId: string;
  timestamp: string;
  input: number;
  output: number;
}) {
  db()
    .prepare(
      `
      INSERT INTO usage_history
        (provider, model, api_key_id, tokens_input, tokens_output,
         tokens_cache_read, tokens_cache_creation, tokens_reasoning,
         service_tier, success, timestamp)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'standard', 1, ?)
    `
    )
    .run("claude", "claude-sonnet-4-6", entry.apiKeyId, entry.input, entry.output, entry.timestamp);
}

test("setQuotaCache records a weekly reset event when Claude advances to a new reset window", () => {
  const connectionId = "conn-reset-event";

  quotaCache.setQuotaCache(connectionId, "claude", {
    "Weekly (7 day)": {
      remainingPercentage: 0,
      resetAt: "2026-06-25T23:00:00.111Z",
    },
  });
  quotaCache.setQuotaCache(connectionId, "claude", {
    "Weekly (7 day)": {
      remainingPercentage: 96,
      resetAt: "2026-07-01T23:00:00.222Z",
    },
  });

  const row = db()
    .prepare(
      `
      SELECT
        provider,
        connection_id as connectionId,
        window_key as windowKey,
        window_started_at as windowStartedAt,
        window_resets_at as windowResetsAt,
        previous_remaining_percentage as previousRemainingPercentage,
        new_remaining_percentage as newRemainingPercentage
      FROM provider_quota_reset_events
      WHERE connection_id = ?
    `
    )
    .get(connectionId);

  assert.deepEqual(row, {
    provider: "claude",
    connectionId,
    windowKey: "Weekly (7 day)",
    windowStartedAt: "2026-06-25T23:00:00.111Z",
    windowResetsAt: "2026-07-01T23:00:00.222Z",
    previousRemainingPercentage: 0,
    newRemainingPercentage: 96,
  });
});

test("setQuotaCache ignores same-day resetAt drift so milliseconds do not create false windows", () => {
  const connectionId = "conn-reset-drift";

  quotaCache.setQuotaCache(connectionId, "claude", {
    "Weekly (7 day)": {
      remainingPercentage: 30,
      resetAt: "2026-06-25T23:00:00.111Z",
    },
  });
  quotaCache.setQuotaCache(connectionId, "claude", {
    "Weekly (7 day)": {
      remainingPercentage: 29,
      resetAt: "2026-06-25T23:00:00.999Z",
    },
  });

  const row = db()
    .prepare("SELECT COUNT(*) as count FROM provider_quota_reset_events WHERE connection_id = ?")
    .get(connectionId);

  assert.equal(row?.count, 0);
});

test("API-key weekly USD limits use the observed reset event instead of resetAt minus seven days", async () => {
  const apiKeyId = "key-weekly-window";
  const connectionId = "conn-weekly-window";
  const oldReset = "2026-06-25T23:00:00.000Z";
  const newReset = "2026-07-01T23:00:00.000Z";
  const now = Date.parse("2026-06-26T12:00:00.000Z");

  quotaResetEvents.recordProviderQuotaResetEventIfChanged({
    provider: "claude",
    connectionId,
    windowKey: "Weekly (7 day)",
    currentResetAt: newReset,
    currentRemainingPercentage: 97,
    previousObservation: {
      resetAt: oldReset,
      remainingPercentage: 0,
    },
    observedAt: "2026-06-25T23:01:00.000Z",
  });

  insertUsage({
    apiKeyId,
    timestamp: "2026-06-25T10:00:00.000Z",
    input: 1000,
    output: 1000,
  });
  insertUsage({
    apiKeyId,
    timestamp: "2026-06-26T10:00:00.000Z",
    input: 1000,
    output: 1000,
  });

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    {
      id: apiKeyId,
      allowedConnections: [connectionId],
      usageLimitEnabled: true,
      dailyUsageLimitUsd: 100,
      weeklyUsageLimitUsd: 100,
    },
    {
      now: () => now,
      getProviderConnectionById: async () => ({
        id: connectionId,
        provider: "claude",
        isActive: true,
      }),
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => ({
        quotas: {
          "Weekly (7 day)": {
            remainingPercentage: 97,
            resetAt: newReset,
          },
        },
        plan: null,
        message: null,
        fetchedAt: new Date(now).toISOString(),
      }),
      getAllProviderLimitsCache: () => ({}),
    }
  );

  const expectedAfterReset = await costCalculator.calculateCost(
    "claude",
    "claude-sonnet-4-6",
    {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
    },
    {
      provider: "claude",
      model: "claude-sonnet-4-6",
      serviceTier: "standard",
    }
  );

  assert.equal(status.weeklyWindowStartIso, oldReset);
  assert.equal(status.weeklyResetAtIso, newReset);
  assert.equal(status.weeklySpentUsd, Math.round(expectedAfterReset * 1_000_000) / 1_000_000);
});
