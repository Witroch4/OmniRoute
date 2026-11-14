import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-key-window-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "claude-key-window-test-secret";

const core = await import("../../src/lib/db/core.ts");
const { updatePricing } = await import("@/lib/db/settings");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const claudeWindow = await import("../../src/lib/usage/claudeKeyWeeklyWindow.ts");
const { weeklyBoundaryWindowMs } = await import("../../open-sse/services/dailyQuotaReset.ts");

const FLAG = "CLAUDE_KEY_QUOTA_FOLLOWS_EARLY_RESET";

// Saturday 2026-11-14 13:30 in Fortaleza (UTC-3, no DST). The standard Claude reset is
// every Thursday 20:00 there = 23:00Z: the last one was 2026-11-12, the next is 2026-11-19.
const NOW = Date.parse("2026-11-14T16:30:00.000Z");
const STANDARD_START = "2026-11-12T23:00:00.000Z";
const STANDARD_RESET = "2026-11-19T23:00:00.000Z";
// The account was reset early, on Friday 12:00 Fortaleza, well before the Thursday reset.
const EARLY_RESET_AT = "2026-11-13T15:00:00.000Z";

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  delete process.env[FLAG];
  await resetStorage();
});

test.after(() => {
  delete process.env[FLAG];
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── The standard weekly boundary (pure clock arithmetic) ───────────────────────────────

test("the Fortaleza Thursday 20:00 window brackets a Saturday", () => {
  assert.deepEqual(claudeWindow.getClaudeStandardWeeklyWindow(NOW), {
    windowStartIso: STANDARD_START,
    resetAtIso: STANDARD_RESET,
  });
});

test("Thursday before 20:00 still belongs to the previous week, and 20:00 sharp opens the next", () => {
  const justBefore = claudeWindow.getClaudeStandardWeeklyWindow(
    Date.parse("2026-11-19T22:59:59.999Z")
  );
  assert.equal(justBefore.windowStartIso, STANDARD_START);
  assert.equal(justBefore.resetAtIso, STANDARD_RESET);

  const exactly = claudeWindow.getClaudeStandardWeeklyWindow(Date.parse(STANDARD_RESET));
  assert.equal(exactly.windowStartIso, STANDARD_RESET);
  assert.equal(exactly.resetAtIso, "2026-11-26T23:00:00.000Z");

  const justAfter = claudeWindow.getClaudeStandardWeeklyWindow(Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(justAfter.windowStartIso, STANDARD_RESET);
});

test("the boundary follows wall-clock time across a DST change", () => {
  // New York, Thursday 20:00. DST began Sunday 2026-03-08, so this week is one hour short.
  const week = weeklyBoundaryWindowMs(
    "America/New_York",
    4,
    20,
    Date.parse("2026-03-10T12:00:00Z")
  );
  assert.equal(new Date(week.startMs).toISOString(), "2026-03-06T01:00:00.000Z"); // EST, UTC-5
  assert.equal(new Date(week.resetMs).toISOString(), "2026-03-13T00:00:00.000Z"); // EDT, UTC-4
  assert.equal((week.resetMs - week.startMs) / 3_600_000, 167);
});

// ─── Key quota windows ───────────────────────────────────────────────────────────────────

async function seedClaudeKey(name: string) {
  await updatePricing({
    claude: {
      "claude-opus-4-8": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });
  const created = await apiKeysDb.createApiKey(name, `machine-${name}`);
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 100,
  });
  // 1 USD per million input tokens.
  for (const [millions, timestamp] of [
    [50, "2026-11-12T20:00:00.000Z"], // Thursday 17:00 Fortaleza: the PREVIOUS standard week
    [7, "2026-11-13T10:00:00.000Z"], // this standard week, before the early reset
    [2, "2026-11-13T18:00:00.000Z"], // after the early reset
  ] as const) {
    await usageHistory.saveRequestUsage({
      provider: "claude",
      model: "claude-opus-4-8",
      apiKeyId: created.id,
      apiKeyName: name,
      tokens: { input: millions * 1_000_000, output: 0 },
      success: true,
      timestamp,
    });
  }
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);
  return metadata;
}

function seedEarlyReset(connectionId: string, provider: string) {
  const db = core.getDbInstance();
  const insertSnapshot = db.prepare(`
    INSERT INTO quota_snapshots (
      provider, connection_id, window_key, remaining_percentage, is_exhausted,
      next_reset_at, window_duration_ms, raw_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSnapshot.run(
    provider,
    connectionId,
    "weekly (7d)",
    20,
    0,
    STANDARD_RESET,
    null,
    null,
    "2026-11-13T14:50:00.000Z"
  );
  insertSnapshot.run(
    provider,
    connectionId,
    "weekly (7d)",
    100,
    0,
    STANDARD_RESET,
    null,
    null,
    EARLY_RESET_AT
  );
  db.prepare(
    `INSERT INTO provider_quota_reset_events
       (provider, connection_id, window_key, window_started_at, window_resets_at,
        observed_at, previous_remaining_percentage, new_remaining_percentage,
        previous_used_percentage, new_used_percentage, raw_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    provider,
    connectionId,
    "weekly (7d)",
    EARLY_RESET_AT,
    STANDARD_RESET,
    EARLY_RESET_AT,
    20,
    100,
    80,
    0,
    null
  );
}

function depsFor(
  connections: Array<{ id: string; provider: string }>,
  withCache = true,
  resetAtByConnection: Record<string, string> = {}
) {
  const rows = connections.map((c) => ({ ...c, isActive: true }));
  const caches: Record<string, unknown> = {};
  if (withCache) {
    for (const c of rows) {
      caches[c.id] = {
        plan: "test",
        quotas: {
          "weekly (7d)": {
            used: 5,
            total: 100,
            resetAt: resetAtByConnection[c.id] ?? STANDARD_RESET,
          },
        },
        message: null,
        fetchedAt: "2026-11-14T16:30:00.000Z",
      };
    }
  }
  return {
    now: () => NOW,
    getProviderConnectionById: async (id: string) => rows.find((c) => c.id === id) ?? null,
    getProviderConnections: async () => rows,
    getProviderLimitsCache: (id: string) => (caches[id] ?? null) as never,
    getAllProviderLimitsCache: () => caches as never,
  };
}

test("by default an early account reset does NOT move a Claude key's weekly window", async () => {
  const metadata = await seedClaudeKey("early-default");
  seedEarlyReset("conn-claude", "claude");

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    depsFor([{ id: "conn-claude", provider: "claude" }])
  );

  assert.equal(status.weeklyWindowStartIso, STANDARD_START);
  assert.equal(status.weeklyResetAtIso, STANDARD_RESET);
  // 7 + 2 since Thursday; the 50 from the previous standard week stays out.
  assert.equal(status.weeklySpentUsd, 9);
});

test("the flag on (env) makes the key window follow the early reset again", async () => {
  const metadata = await seedClaudeKey("early-env");
  seedEarlyReset("conn-claude", "claude");
  process.env[FLAG] = "true";

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    depsFor([{ id: "conn-claude", provider: "claude" }])
  );

  assert.equal(status.weeklyWindowStartIso, EARLY_RESET_AT);
  assert.equal(status.weeklySpentUsd, 2);
});

test("the dashboard switch (DB override) beats the env in both directions", async () => {
  const metadata = await seedClaudeKey("early-switch");
  seedEarlyReset("conn-claude", "claude");
  const scoped = { ...metadata, allowedConnections: ["conn-claude"] };
  const deps = depsFor([{ id: "conn-claude", provider: "claude" }]);

  featureFlagsDb.setFeatureFlagOverride(FLAG, "true");
  let status = await usageLimits.getApiKeyUsageLimitStatus(scoped, deps);
  assert.equal(status.weeklyWindowStartIso, EARLY_RESET_AT, "switch on, env unset");

  process.env[FLAG] = "true";
  featureFlagsDb.setFeatureFlagOverride(FLAG, "false");
  status = await usageLimits.getApiKeyUsageLimitStatus(scoped, deps);
  assert.equal(status.weeklyWindowStartIso, STANDARD_START, "switch off wins over env on");
});

test("a Claude key gets the standard window even with no provider cache at all", async () => {
  const metadata = await seedClaudeKey("no-cache");

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    depsFor([{ id: "conn-claude", provider: "claude" }], false)
  );

  // Not the rolling-7d fallback (which would start at NOW - 7d).
  assert.equal(status.weeklyWindowStartIso, STANDARD_START);
  assert.equal(status.weeklyResetAtIso, STANDARD_RESET);
});

test("a key scoped to Claude by model allow-list (cc/ alias) uses the standard window", async () => {
  const metadata = await seedClaudeKey("scoped-by-model");
  seedEarlyReset("conn-claude", "claude");

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: [], allowedModels: ["cc/claude-opus-4-8"] },
    depsFor([{ id: "conn-claude", provider: "claude" }])
  );

  assert.equal(status.weeklyWindowStartIso, STANDARD_START);
});

test("an unscoped key picks the earliest reset and uses the standard window for a Claude one", async () => {
  const metadata = await seedClaudeKey("unscoped");
  seedEarlyReset("conn-claude", "claude");
  const connections = [
    { id: "conn-claude", provider: "claude" },
    { id: "conn-codex", provider: "codex" },
  ];
  // Codex resets later than Claude, so Claude is the earliest and decides the window.
  const deps = depsFor(connections, true, { "conn-codex": "2026-11-25T10:00:00.000Z" });

  const unscoped = { ...metadata, allowedConnections: [] };
  let status = await usageLimits.getApiKeyUsageLimitStatus(unscoped, deps);
  assert.equal(status.weeklyWindowStartIso, STANDARD_START);
  assert.equal(status.weeklyResetAtIso, STANDARD_RESET);

  process.env[FLAG] = "true";
  status = await usageLimits.getApiKeyUsageLimitStatus(unscoped, deps);
  assert.equal(status.weeklyWindowStartIso, EARLY_RESET_AT, "flag on keeps the observed window");
});

test("Codex keys are not touched: an early Codex reset still moves their window", async () => {
  await updatePricing({
    codex: { "gpt-test": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 } },
  });
  const created = await apiKeysDb.createApiKey("codex-key", "machine-codex-key");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 100,
  });
  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-test",
    apiKeyId: created.id,
    apiKeyName: "codex-key",
    tokens: { input: 2_000_000, output: 0 },
    success: true,
    timestamp: "2026-11-13T18:00:00.000Z",
  });
  seedEarlyReset("conn-codex", "codex");
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-codex"] },
    depsFor([{ id: "conn-codex", provider: "codex" }])
  );

  assert.equal(status.weeklyWindowStartIso, EARLY_RESET_AT);
  assert.equal(status.weeklySpentUsd, 2);
});

test("budget rules and the Cost Explorer read the same standard window", async () => {
  const metadata = await seedClaudeKey("shared-window");
  seedEarlyReset("conn-claude", "claude");
  const scoped = { ...metadata, allowedConnections: ["conn-claude"] };
  const deps = depsFor([{ id: "conn-claude", provider: "claude" }]);

  assert.equal(await usageLimits.getApiKeyWeeklyWindowStartIso(scoped, deps, NOW), STANDARD_START);

  const resolved = await usageLimits.resolveApiKeyWeeklyWindow(scoped, deps, NOW);
  assert.equal(resolved.windowStartIso, STANDARD_START);
  assert.equal(resolved.resetAtIso, STANDARD_RESET);
  assert.equal(resolved.isObserved, true);
});

test("the provider's own reset records are still written, only the key window ignores them", async () => {
  await seedClaudeKey("records-kept");
  seedEarlyReset("conn-claude", "claude");
  const rows = core
    .getDbInstance()
    .prepare("SELECT window_started_at AS startedAt FROM provider_quota_reset_events")
    .all() as Array<{ startedAt: string }>;
  assert.deepEqual(
    rows.map((r) => r.startedAt),
    [EARLY_RESET_AT]
  );
});
