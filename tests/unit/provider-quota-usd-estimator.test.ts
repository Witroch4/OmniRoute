import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-quota-usd-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "provider-quota-usd-test-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const estimator = await import("../../src/lib/usage/providerQuotaUsdEstimator.ts");

async function resetStorage() {
  core.resetDbInstance();
  usageHistory.clearPendingRequests();
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

test("Codex estimate converts observed USD spend and consumed percent into a 25% value", async () => {
  await localDb.updatePricing({
    codex: {
      "gpt-5.4": {
        input: 1,
        cached: 1,
        output: 1,
        reasoning: 1,
        cache_creation: 1,
      },
    },
  });

  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.4",
    connectionId: "conn-codex",
    tokens: { input: 130_000, output: 0 },
    success: true,
    timestamp: "2026-06-24T22:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.4",
    connectionId: "conn-codex",
    tokens: { input: 900_000, output: 0 },
    success: true,
    timestamp: "2026-06-24T20:30:00.000Z",
  });

  const estimate = await estimator.buildProviderQuotaUsdEstimate(
    { id: "conn-codex", provider: "codex" },
    {
      fetchedAt: "2026-06-25T12:00:00.000Z",
      plan: "Plus",
      message: null,
      quotas: {
        weekly: {
          used: 13,
          total: 100,
          remainingPercentage: 87,
          resetAt: "2026-07-01T21:00:00.000Z",
        },
      },
    },
    { now: () => Date.parse("2026-06-25T12:00:00.000Z") }
  );

  assert.equal(estimate.windows.length, 1);
  const weekly = estimate.windows[0];
  assert.equal(weekly.provider, "codex");
  assert.equal(weekly.windowName, "weekly");
  assert.equal(weekly.windowStartIso, "2026-06-24T21:00:00.000Z");
  assert.equal(weekly.remainingPercentage, 87);
  assert.equal(weekly.usedPercentage, 13);
  assert.equal(weekly.observedSpendUsd, 0.13);
  assert.equal(weekly.estimatedFullWindowUsd, 1);
  assert.equal(weekly.estimatedUsdPerPercent, 0.01);
  assert.equal(estimator.estimateUsdForPercent(weekly, 25), 0.25);
});

test("Claude Code estimate uses the observed reset event and excludes prior-window spend", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": {
        input: 1,
        cached: 1,
        output: 1,
        reasoning: 1,
        cache_creation: 1,
      },
    },
  });

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude",
    tokens: { input: 5_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-24T09:30:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude",
    tokens: { input: 500_000, output: 0 },
    success: true,
    timestamp: "2026-06-24T10:30:00.000Z",
  });

  core
    .getDbInstance()
    .prepare(
      `
      INSERT INTO provider_quota_reset_events
        (provider, connection_id, window_key, window_started_at, window_resets_at,
         observed_at, previous_remaining_percentage, new_remaining_percentage,
         previous_used_percentage, new_used_percentage, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      "claude",
      "conn-claude",
      "weekly (7d)",
      "2026-06-24T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z",
      "2026-06-24T10:01:00.000Z",
      0,
      100,
      100,
      0,
      null
    );

  const estimate = await estimator.buildProviderQuotaUsdEstimate(
    { id: "conn-claude", provider: "claude" },
    {
      fetchedAt: "2026-06-25T12:00:00.000Z",
      plan: "Claude Max",
      message: null,
      quotas: {
        "weekly (7d)": {
          used: 25,
          total: 100,
          remainingPercentage: 75,
          resetAt: "2026-07-01T10:00:00.000Z",
        },
      },
    },
    { now: () => Date.parse("2026-06-25T12:00:00.000Z") }
  );

  const weekly = estimate.windows[0];
  assert.equal(weekly.provider, "claude");
  assert.equal(weekly.windowName, "weekly (7d)");
  assert.equal(weekly.windowStartIso, "2026-06-24T10:00:00.000Z");
  assert.equal(weekly.windowStartSource, "reset_event");
  assert.equal(weekly.observedSpendUsd, 0.5);
  assert.equal(weekly.estimatedFullWindowUsd, 2);
  assert.equal(estimator.estimateUsdForPercent(weekly, 25), 0.5);
});

test("provider quota USD estimate prefers recorded API-key spend over repricing history", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": {
        input: 1,
        cached: 0.1,
        output: 1,
        reasoning: 1,
        cache_creation: 1,
      },
    },
  });

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude-recorded",
    apiKeyId: "api-key-recorded",
    tokens: { input: 1_000_000, cacheRead: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-24T10:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude-recorded",
    apiKeyId: "api-key-recorded",
    tokens: { input: 1_000_000, cacheRead: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-24T10:01:00.000Z",
  });
  core
    .getDbInstance()
    .prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)")
    .run("api-key-recorded", 10, Date.parse("2026-06-24T10:00:00.010Z"));
  core
    .getDbInstance()
    .prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)")
    .run("api-key-recorded", 7, Date.parse("2026-06-24T10:01:00.010Z"));

  const estimate = await estimator.buildProviderQuotaUsdEstimate(
    { id: "conn-claude-recorded", provider: "claude" },
    {
      fetchedAt: "2026-06-25T12:00:00.000Z",
      plan: "Claude Max",
      message: null,
      quotas: {
        "weekly (7d)": {
          used: 50,
          total: 100,
          remainingPercentage: 50,
          resetAt: "2026-07-01T10:00:00.000Z",
        },
      },
    },
    { now: () => Date.parse("2026-06-25T12:00:00.000Z") }
  );

  const weekly = estimate.windows[0];
  assert.equal(estimate.costSource, "recorded_cost_history_or_usage_history_pricing");
  assert.equal(weekly.observedSpendUsd, 17);
  assert.equal(weekly.estimatedFullWindowUsd, 34);
  assert.equal(estimator.estimateUsdForPercent(weekly, 25), 8.5);
});

test("weekly estimate uses reset-derived start instead of a late first snapshot", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": {
        input: 1,
        cached: 1,
        output: 1,
        reasoning: 1,
        cache_creation: 1,
      },
    },
  });

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude-late-snapshot",
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T10:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude-late-snapshot",
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-21T10:00:00.000Z",
  });

  core
    .getDbInstance()
    .prepare(
      `
      INSERT INTO quota_snapshots
        (provider, connection_id, window_key, remaining_percentage, is_exhausted,
         next_reset_at, window_duration_ms, raw_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      "claude",
      "conn-claude-late-snapshot",
      "weekly (7d)",
      50,
      0,
      "2026-06-25T23:00:00.000Z",
      7 * 24 * 60 * 60 * 1000,
      null,
      "2026-06-20T15:38:57.000Z"
    );

  const estimate = await estimator.buildProviderQuotaUsdEstimate(
    { id: "conn-claude-late-snapshot", provider: "claude" },
    {
      fetchedAt: "2026-06-25T21:35:00.000Z",
      plan: "Claude Max",
      message: null,
      quotas: {
        "weekly (7d)": {
          used: 50,
          total: 100,
          remainingPercentage: 50,
          resetAt: "2026-06-25T23:00:00.000Z",
        },
      },
    },
    { now: () => Date.parse("2026-06-25T21:35:00.000Z") }
  );

  const weekly = estimate.windows[0];
  assert.equal(weekly.windowStartIso, "2026-06-18T23:00:00.000Z");
  assert.equal(weekly.windowStartSource, "inferred");
  assert.equal(weekly.observedSpendUsd, 2);
  assert.equal(weekly.estimatedFullWindowUsd, 4);
});

test("weekly estimate includes sequential historical connection spend for a single active provider account", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": {
        input: 1,
        cached: 1,
        output: 1,
        reasoning: 1,
        cache_creation: 1,
      },
    },
  });

  core
    .getDbInstance()
    .prepare(
      `
      INSERT INTO provider_connections
        (id, provider, auth_type, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      "conn-claude-active",
      "claude",
      "oauth",
      "Claude active",
      1,
      "2026-06-20T15:38:00.000Z",
      "2026-06-20T15:38:00.000Z"
    );

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude-old",
    apiKeyId: "api-key-shared",
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T10:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    connectionId: "conn-claude-active",
    apiKeyId: "api-key-shared",
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-21T10:00:00.000Z",
  });
  core
    .getDbInstance()
    .prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)")
    .run("api-key-shared", 12, Date.parse("2026-06-19T10:00:00.010Z"));
  core
    .getDbInstance()
    .prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)")
    .run("api-key-shared", 18, Date.parse("2026-06-21T10:00:00.010Z"));

  const estimate = await estimator.buildProviderQuotaUsdEstimate(
    { id: "conn-claude-active", provider: "claude" },
    {
      fetchedAt: "2026-06-25T21:35:00.000Z",
      plan: "Claude Max",
      message: null,
      quotas: {
        "weekly (7d)": {
          used: 50,
          total: 100,
          remainingPercentage: 50,
          resetAt: "2026-06-25T23:00:00.000Z",
        },
      },
    },
    { now: () => Date.parse("2026-06-25T21:35:00.000Z") }
  );

  const weekly = estimate.windows[0];
  assert.equal(weekly.observedRequests, 2);
  assert.equal(weekly.observedSpendUsd, 30);
  assert.equal(weekly.estimatedFullWindowUsd, 60);
});
