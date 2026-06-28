import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-costs-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "provider-window-costs-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const localDb = await import("../../src/lib/localDb.ts");
const providerLimits = await import("../../src/lib/db/providerLimits.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const costRules = await import("../../src/domain/costRules.ts");
const { getProviderWindowCostBreakdown } =
  await import("../../src/lib/usage/providerWindowCosts.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  costRules.resetCostData();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  costRules.resetCostData();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Codex provider window costs use the weekly reset window and API key USD limit", async () => {
  await localDb.updatePricing({
    codex: {
      "gpt-5.5": { input: 10, output: 20, cached: 1, cache_creation: 5, reasoning: 30 },
    },
  });

  const key = await apiKeys.createApiKey("Codex Key", "machine-codex-window");
  costRules.setBudget(key.id, {
    dailyLimitUsd: 0,
    weeklyLimitUsd: 40,
    resetInterval: "weekly",
    resetTime: "00:00",
  });

  providerLimits.setProviderLimitsCache("codex-conn", {
    quotas: {
      "session (5h)": {
        used: 0,
        total: 100,
        remainingPercentage: 100,
        resetAt: "2026-06-28T16:00:00.000Z",
      },
      "weekly (7d)": {
        used: 13,
        total: 100,
        remainingPercentage: 87,
        resetAt: "2026-07-02T23:00:00.000Z",
      },
    },
    plan: "Prolite",
    message: null,
    fetchedAt: "2026-06-28T12:00:00.000Z",
  });

  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.5",
    connectionId: "codex-conn",
    apiKeyId: key.id,
    apiKeyName: "Old Codex Key",
    tokens: { input: 1_000_000, output: 0 },
    timestamp: "2026-06-26T00:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.5",
    connectionId: "codex-conn",
    apiKeyId: key.id,
    apiKeyName: "Old Codex Key",
    tokens: { input: 1_000_000, output: 0 },
    timestamp: "2026-06-25T22:59:59.000Z",
  });

  const result = await getProviderWindowCostBreakdown({
    provider: "codex",
    connectionId: "codex-conn",
    now: Date.parse("2026-06-28T12:00:00.000Z"),
  });

  assert.equal(result.windowStartAt, "2026-06-25T23:00:00.000Z");
  assert.equal(result.windowResetAt, "2026-07-02T23:00:00.000Z");
  assert.equal(result.windowSource, "provider_weekly_reset");
  assert.equal(result.quotaUsedPercent, 13);
  assert.equal(result.totalCostUsd, 10);
  assert.equal(result.estimatedFullQuotaUsd, 76.923077);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].apiKeyName, "Codex Key");
  assert.equal(result.rows[0].costUsd, 10);
  assert.equal(result.rows[0].limitUsd, 40);
  assert.equal(result.rows[0].limitUsedPercent, 25);
});

test("Claude provider window costs split spending across API keys from the current weekly window", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-sonnet-4": { input: 3, output: 15, cached: 0.3, cache_creation: 3.75 },
    },
  });

  const heavyKey = await apiKeys.createApiKey("Claude Heavy", "machine-claude-heavy");
  const lightKey = await apiKeys.createApiKey("Claude Light", "machine-claude-light");
  costRules.setBudget(heavyKey.id, {
    dailyLimitUsd: 0,
    weeklyLimitUsd: 20,
    resetInterval: "weekly",
    resetTime: "00:00",
  });

  providerLimits.setProviderLimitsCache("claude-conn", {
    quotas: {
      "Session (5hr)": {
        used: 2,
        total: 100,
        remainingPercentage: 98,
        resetAt: "2026-06-28T15:30:00.000Z",
      },
      "Weekly (7 day)": {
        used: 54,
        total: 100,
        remainingPercentage: 46,
        resetAt: "2026-07-02T23:00:00.000Z",
      },
      "Weekly Sonnet": {
        used: 18,
        total: 100,
        remainingPercentage: 82,
        resetAt: "2026-07-02T23:00:00.000Z",
      },
    },
    plan: "default_claude_max_20x",
    message: null,
    fetchedAt: "2026-06-28T12:00:00.000Z",
  });

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-sonnet-4",
    connectionId: "claude-conn",
    apiKeyId: heavyKey.id,
    apiKeyName: "Heavy old",
    tokens: { input: 1_000_000, output: 0 },
    timestamp: "2026-06-26T00:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-sonnet-4",
    connectionId: "claude-conn",
    apiKeyId: lightKey.id,
    apiKeyName: "Light old",
    tokens: { input: 500_000, output: 0 },
    timestamp: "2026-06-27T00:00:00.000Z",
  });

  const result = await getProviderWindowCostBreakdown({
    provider: "claude",
    connectionId: "claude-conn",
    now: Date.parse("2026-06-28T12:00:00.000Z"),
  });

  assert.equal(result.windowStartAt, "2026-06-25T23:00:00.000Z");
  assert.equal(result.quotaName, "Weekly (7 day)");
  assert.equal(result.quotaUsedPercent, 54);
  assert.equal(result.quotaRemainingPercent, 46);
  assert.equal(result.totalCostUsd, 4.5);
  assert.equal(result.estimatedFullQuotaUsd, 8.333333);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].apiKeyName, "Claude Heavy");
  assert.equal(result.rows[0].costUsd, 3);
  assert.equal(result.rows[0].limitUsd, 20);
  assert.equal(result.rows[0].limitUsedPercent, 15);
  assert.equal(result.rows[1].apiKeyName, "Claude Light");
  assert.equal(result.rows[1].costUsd, 1.5);
  assert.equal(result.rows[1].limitUsd, null);
});
