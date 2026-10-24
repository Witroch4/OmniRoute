import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-usage-limits-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "usage-limit-test-secret";

const core = await import("../../src/lib/db/core.ts");
const { updatePricing } = await import("@/lib/db/settings");
const localDb = { updatePricing };
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");

const NOW = Date.parse("2026-06-19T20:00:00.000Z");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("API key USD usage limits persist and default off", async () => {
  const created = await apiKeysDb.createApiKey("Usage Limit Key", "machine-limit-01");

  let metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.equal(metadata?.usageLimitEnabled, false);
  assert.equal(metadata?.dailyUsageLimitUsd, null);
  assert.equal(metadata?.weeklyUsageLimitUsd, null);

  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 10.5,
    weeklyUsageLimitUsd: 50,
  });
  apiKeysDb.clearApiKeyCaches();

  metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.equal(metadata?.usageLimitEnabled, true);
  assert.equal(metadata?.dailyUsageLimitUsd, 10.5);
  assert.equal(metadata?.weeklyUsageLimitUsd, 50);
});

test("getApiKeyUsageLimitStatus aligns weekly USD spend with provider resetAt when available", async () => {
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

  const created = await apiKeysDb.createApiKey("Metered Key", "machine-limit-02");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 10,
    weeklyUsageLimitUsd: 20,
  });

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Metered Key",
    tokens: { input: 2_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Metered Key",
    tokens: { input: 3_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-18T21:00:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Metered Key",
    tokens: { input: 7_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-18T12:00:00.000Z",
  });

  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const weeklyResetAt = "2026-06-25T20:00:00.000Z";
  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    {
      now: () => NOW,
      getProviderConnectionById: async () => ({
        id: "conn-claude",
        provider: "claude",
        isActive: true,
      }),
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => ({
        plan: "Claude Max",
        quotas: {
          "weekly (7d)": {
            used: 27,
            total: 100,
            resetAt: weeklyResetAt,
          },
        },
        message: null,
        fetchedAt: new Date(NOW).toISOString(),
      }),
      getAllProviderLimitsCache: () => ({}),
    }
  );

  assert.equal(status.enabled, true);
  assert.equal(status.dailySpentUsd, 2);
  assert.equal(status.weeklySpentUsd, 5);
  assert.equal(status.dailyLimitUsd, 10);
  assert.equal(status.weeklyLimitUsd, 20);
  assert.equal(status.dailyResetAtIso, "2026-06-20T03:00:00.000Z");
  assert.equal(status.weeklyWindowStartIso, "2026-06-18T20:00:00.000Z");
  assert.equal(status.weeklyResetAtIso, weeklyResetAt);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyExceeded, false);
});

test("getApiKeyUsageLimitStatus cuts weekly USD spend at observed provider quota reset", async () => {
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

  const created = await apiKeysDb.createApiKey("Reset Cut Key", "machine-limit-reset");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 10,
    weeklyUsageLimitUsd: 20,
  });

  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Reset Cut Key",
    tokens: { input: 7_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T23:30:00.000Z",
  });
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Reset Cut Key",
    tokens: { input: 2_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-20T02:00:00.000Z",
  });

  const db = core.getDbInstance();
  const insertSnapshot = db.prepare(`
    INSERT INTO quota_snapshots (
      provider,
      connection_id,
      window_key,
      remaining_percentage,
      is_exhausted,
      next_reset_at,
      window_duration_ms,
      raw_data,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSnapshot.run(
    "claude",
    "conn-claude",
    "weekly (7d)",
    72,
    0,
    "2026-06-25T23:00:00.000Z",
    null,
    null,
    "2026-06-19T23:55:00.000Z"
  );
  insertSnapshot.run(
    "claude",
    "conn-claude",
    "weekly (7d)",
    100,
    0,
    "2026-06-25T23:00:00.000Z",
    null,
    null,
    "2026-06-20T01:42:52.590Z"
  );
  insertSnapshot.run(
    "claude",
    "conn-claude",
    "weekly (7d)",
    99,
    0,
    "2026-06-25T23:00:00.000Z",
    null,
    null,
    "2026-06-20T02:10:00.000Z"
  );
  db.prepare(
    `
    INSERT INTO provider_quota_reset_events
      (provider, connection_id, window_key, window_started_at, window_resets_at,
       observed_at, previous_remaining_percentage, new_remaining_percentage,
       previous_used_percentage, new_used_percentage, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    "claude",
    "conn-claude",
    "weekly (7d)",
    "2026-06-18T23:00:00.000Z",
    "2026-06-25T23:00:00.000Z",
    "2026-06-18T23:04:00.000Z",
    0,
    100,
    100,
    0,
    null
  );

  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const weeklyResetAt = "2026-06-25T23:00:00.000Z";
  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    {
      now: () => Date.parse("2026-06-20T14:30:00.000Z"),
      getProviderConnectionById: async () => ({
        id: "conn-claude",
        provider: "claude",
        isActive: true,
      }),
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => ({
        plan: "Claude Max",
        quotas: {
          "weekly (7d)": {
            used: 5,
            total: 100,
            resetAt: weeklyResetAt,
          },
        },
        message: null,
        fetchedAt: "2026-06-20T14:30:00.000Z",
      }),
      getAllProviderLimitsCache: () => ({}),
    }
  );

  assert.equal(status.weeklyWindowStartIso, "2026-06-20T01:42:52.590Z");
  assert.equal(status.weeklySpentUsd, 2);
});

const WEEKLY_WINDOW_ENV_KEYS = [
  "OMNIROUTE_API_KEY_WEEKLY_WINDOW",
  "OMNIROUTE_API_KEY_WEEKLY_WINDOW_TIMEZONE",
  "TZ",
] as const;

async function withWeeklyWindowEnv<T>(
  values: Partial<Record<(typeof WEEKLY_WINDOW_ENV_KEYS)[number], string>>,
  run: () => Promise<T>
): Promise<T> {
  const saved = Object.fromEntries(WEEKLY_WINDOW_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of WEEKLY_WINDOW_ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await run();
  } finally {
    for (const key of WEEKLY_WINDOW_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// A shared multi-account pool: two upstream accounts whose weekly resets are
// days apart. In provider mode the key's window follows the earliest one.
function sharedPoolDeps(now: number) {
  const connections = [
    { id: "pool-a", provider: "codex", isActive: true },
    { id: "pool-b", provider: "codex", isActive: true },
  ];
  const caches: Record<string, { quotas: Record<string, { resetAt: string }> }> = {
    "pool-a": { quotas: { weekly: { resetAt: "2026-09-23T06:47:00.000Z" } } },
    "pool-b": { quotas: { weekly: { resetAt: "2026-09-28T02:20:00.000Z" } } },
  };
  return {
    now: () => now,
    getProviderConnectionById: async (id: string) => connections.find((c) => c.id === id) ?? null,
    getProviderConnections: async () => connections,
    getProviderLimitsCache: (id: string) => (caches[id] ?? null) as never,
    getAllProviderLimitsCache: () => caches as never,
  };
}

async function seedSharedPoolKey(name: string) {
  await localDb.updatePricing({
    codex: { "gpt-test": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 } },
  });
  const created = await apiKeysDb.createApiKey(name, `machine-${name}`);
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 100,
  });
  // Sunday 2026-09-20 15:00Z = Sunday 23:00 in Asia/Shanghai (previous local week).
  // Monday 2026-09-21 02:00Z = Monday 10:00 in Asia/Shanghai (current local week).
  for (const [input, timestamp] of [
    [40_000_000, "2026-09-16T08:00:00.000Z"],
    [7_000_000, "2026-09-20T15:00:00.000Z"],
    [3_000_000, "2026-09-21T02:00:00.000Z"],
  ] as const) {
    await usageHistory.saveRequestUsage({
      provider: "codex",
      model: "gpt-test",
      apiKeyId: created.id,
      apiKeyName: name,
      tokens: { input, output: 0 },
      success: true,
      timestamp,
    });
  }
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);
  return metadata;
}

// Wednesday 2026-09-23 05:55Z = Wednesday 13:55 in Asia/Shanghai.
const POOL_NOW = Date.parse("2026-09-23T05:55:00.000Z");

test("weekly window defaults to the earliest provider reset when the env is unset", async () => {
  const metadata = await seedSharedPoolKey("pool-default");
  const status = await withWeeklyWindowEnv({}, () =>
    usageLimits.getApiKeyUsageLimitStatus(metadata, sharedPoolDeps(POOL_NOW))
  );

  assert.equal(status.weeklyResetAtIso, "2026-09-23T06:47:00.000Z");
  assert.equal(status.weeklyWindowStartIso, "2026-09-16T06:47:00.000Z");
  assert.equal(status.weeklySpentUsd, 50);
});

test("calendar weekly window starts Monday 00:00 in the configured timezone", async () => {
  const metadata = await seedSharedPoolKey("pool-calendar");
  const status = await withWeeklyWindowEnv(
    {
      OMNIROUTE_API_KEY_WEEKLY_WINDOW: "calendar",
      OMNIROUTE_API_KEY_WEEKLY_WINDOW_TIMEZONE: "Asia/Shanghai",
    },
    () => usageLimits.getApiKeyUsageLimitStatus(metadata, sharedPoolDeps(POOL_NOW))
  );

  assert.equal(status.weeklyWindowStartIso, "2026-09-20T16:00:00.000Z");
  assert.equal(status.weeklyResetAtIso, "2026-09-27T16:00:00.000Z");
  assert.equal(status.weeklySpentUsd, 3);
  assert.equal(status.weeklyExceeded, false);
});

test("calendar weekly window does not move when the pool's accounts reset", async () => {
  const metadata = await seedSharedPoolKey("pool-stable");
  const env = {
    OMNIROUTE_API_KEY_WEEKLY_WINDOW: "calendar",
    OMNIROUTE_API_KEY_WEEKLY_WINDOW_TIMEZONE: "Asia/Shanghai",
  };
  const before = await withWeeklyWindowEnv(env, () =>
    usageLimits.getApiKeyUsageLimitStatus(metadata, sharedPoolDeps(POOL_NOW))
  );
  // One hour later pool-a has reset; provider mode would jump to pool-b's window.
  const afterDeps = sharedPoolDeps(POOL_NOW + 60 * 60 * 1000);
  const after = await withWeeklyWindowEnv(env, () =>
    usageLimits.getApiKeyUsageLimitStatus(metadata, afterDeps)
  );

  assert.equal(after.weeklyWindowStartIso, before.weeklyWindowStartIso);
  assert.equal(after.weeklyResetAtIso, before.weeklyResetAtIso);
  assert.equal(after.weeklySpentUsd, before.weeklySpentUsd);

  // Contrast: provider mode, same key, same hour.
  const providerBefore = await withWeeklyWindowEnv({}, () =>
    usageLimits.getApiKeyUsageLimitStatus(metadata, sharedPoolDeps(POOL_NOW))
  );
  const providerAfter = await withWeeklyWindowEnv({}, () =>
    usageLimits.getApiKeyUsageLimitStatus(metadata, afterDeps)
  );
  assert.equal(providerBefore.weeklySpentUsd, 50);
  assert.equal(providerAfter.weeklyWindowStartIso, "2026-09-21T02:20:00.000Z");
  assert.equal(providerAfter.weeklySpentUsd, 0);
});

test("calendar weekly window uses the process timezone when no timezone is configured", async () => {
  const metadata = await seedSharedPoolKey("pool-process-tz");
  const status = await withWeeklyWindowEnv(
    { OMNIROUTE_API_KEY_WEEKLY_WINDOW: "calendar", TZ: "UTC" },
    () => usageLimits.getApiKeyUsageLimitStatus(metadata, sharedPoolDeps(POOL_NOW))
  );

  assert.equal(status.weeklyWindowStartIso, "2026-09-21T00:00:00.000Z");
  assert.equal(status.weeklyResetAtIso, "2026-09-28T00:00:00.000Z");
  assert.equal(status.weeklySpentUsd, 3);
});

test("invalid weekly window values fall back instead of failing requests", () => {
  assert.deepEqual(
    usageLimits.getApiKeyWeeklyWindowSetting({
      OMNIROUTE_API_KEY_WEEKLY_WINDOW: "fortnight",
      OMNIROUTE_API_KEY_WEEKLY_WINDOW_TIMEZONE: "Asia/Shanghai",
    }),
    { mode: "provider", timeZone: "Asia/Shanghai" }
  );
  const fallback = usageLimits.getApiKeyWeeklyWindowSetting({
    OMNIROUTE_API_KEY_WEEKLY_WINDOW: " Calendar ",
    OMNIROUTE_API_KEY_WEEKLY_WINDOW_TIMEZONE: "Not/AZone",
  });
  assert.equal(fallback.mode, "calendar");
  assert.equal(fallback.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("buildApiKeyUsageLimitText returns API-key quota spend percentage and reset lines", async () => {
  const text = usageLimits.buildApiKeyUsageLimitText(
    {
      enabled: true,
      dailyLimitUsd: 10,
      weeklyLimitUsd: 50,
      dailySpentUsd: 2,
      weeklySpentUsd: 5.25,
      dailyWindowStartIso: "2026-06-19T03:00:00.000Z",
      dailyResetAtIso: "2026-06-20T03:00:00.000Z",
      weeklyWindowStartIso: "2026-06-12T20:00:00.000Z",
      weeklyResetAtIso: "2026-06-25T20:00:00.000Z",
      dailyExceeded: false,
      weeklyExceeded: false,
    },
    Date.parse("2026-06-19T20:00:00.000Z")
  );

  assert.equal(
    text,
    [
      "Daily quota",
      "$10.00",
      "Daily spent",
      "$2.00",
      "Daily used",
      "20%",
      "Resets in 7h 0m",
      "",
      "Weekly quota",
      "$50.00",
      "Weekly spent",
      "$5.25",
      "Weekly used",
      "11%",
      "Resets in 6d 0h 0m",
    ].join("\n")
  );
});

test("buildApiKeyUsageLimitPercentText returns remaining percentages only", () => {
  const text = usageLimits.buildApiKeyUsageLimitPercentText(
    {
      enabled: true,
      dailyLimitUsd: 10,
      weeklyLimitUsd: 50,
      dailySpentUsd: 2,
      weeklySpentUsd: 5.25,
      dailyWindowStartIso: "2026-06-19T03:00:00.000Z",
      dailyResetAtIso: "2026-06-20T03:00:00.000Z",
      weeklyWindowStartIso: "2026-06-12T20:00:00.000Z",
      weeklyResetAtIso: "2026-06-25T20:00:00.000Z",
      dailyExceeded: false,
      weeklyExceeded: false,
    },
    Date.parse("2026-06-19T20:00:00.000Z")
  );

  assert.equal(
    text,
    ["Daily", "80% left", "⏱ reset in 7h 0m", "", "Weekly", "90% left", "⏱ reset in 6d 0h 0m"].join(
      "\n"
    )
  );
});

test("buildApiKeyUsageLimitRejection includes over-quota percentage and reset hint", async () => {
  const response = usageLimits.buildApiKeyUsageLimitRejection(
    new Request("http://localhost/v1/messages", {
      headers: { "anthropic-version": "2023-06-01" },
    }),
    {
      enabled: true,
      dailyLimitUsd: 10,
      weeklyLimitUsd: 1,
      dailySpentUsd: 0.25,
      weeklySpentUsd: 1.09,
      dailyWindowStartIso: "2026-06-19T03:00:00.000Z",
      dailyResetAtIso: "2026-06-20T03:00:00.000Z",
      weeklyWindowStartIso: "2026-06-12T20:00:00.000Z",
      weeklyResetAtIso: "2026-06-25T20:00:00.000Z",
      dailyExceeded: false,
      weeklyExceeded: true,
    },
    Date.parse("2026-06-19T20:00:00.000Z")
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.equal(
    body.error.message,
    "This API key reached its weekly USD usage quota ($1.09 of $1.00, 109%). Resets in 6d 0h 0m. Choose another allowed model after reset."
  );
});

test("buildApiKeyUsageLimitRejection can hide USD amounts for client-facing policy errors", async () => {
  const response = usageLimits.buildApiKeyUsageLimitRejection(
    new Request("http://localhost/v1/messages", {
      headers: { "anthropic-version": "2023-06-01" },
    }),
    {
      enabled: true,
      dailyLimitUsd: 10,
      weeklyLimitUsd: 1,
      dailySpentUsd: 0.25,
      weeklySpentUsd: 1.09,
      dailyWindowStartIso: "2026-06-19T03:00:00.000Z",
      dailyResetAtIso: "2026-06-20T03:00:00.000Z",
      weeklyWindowStartIso: "2026-06-12T20:00:00.000Z",
      weeklyResetAtIso: "2026-06-25T20:00:00.000Z",
      dailyExceeded: false,
      weeklyExceeded: true,
    },
    Date.parse("2026-06-19T20:00:00.000Z"),
    { showUsd: false }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.equal(
    body.error.message,
    "This API key reached its weekly usage quota (109%). Resets in 6d 0h 0m. Choose another allowed model after reset."
  );
});

test("buildApiKeyUsageLimitRejection returns structured reset timing to non-Anthropic clients", async () => {
  const resetAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const response = usageLimits.buildApiKeyUsageLimitRejection(
    new Request("http://localhost/v1/chat/completions"),
    {
      enabled: true,
      dailyLimitUsd: 10,
      weeklyLimitUsd: null,
      dailySpentUsd: 12,
      weeklySpentUsd: 12,
      dailyWindowStartIso: new Date(Date.now() - 60_000).toISOString(),
      dailyResetAtIso: resetAt,
      weeklyWindowStartIso: null,
      weeklyResetAtIso: null,
      dailyExceeded: true,
      weeklyExceeded: false,
    }
  );

  assert.equal(response.status, 429);
  const body = (await response.json()) as {
    error: { code?: string; retry_after?: number; reset_at?: string };
  };
  assert.equal(body.error.code, "usage_limit_exceeded");
  assert.equal(body.error.reset_at, resetAt);
  assert.ok(body.error.retry_after! >= 299 && body.error.retry_after! <= 300);
  assert.equal(response.headers.get("Retry-After"), String(body.error.retry_after));
});

test("buildApiKeyUsageLimitRejection uses 400 so Claude Code does not trigger login", async () => {
  const response = usageLimits.buildApiKeyUsageLimitRejection(
    new Request("http://localhost/v1/messages", {
      headers: { "anthropic-version": "2023-06-01" },
    }),
    {
      enabled: true,
      dailyLimitUsd: 10,
      weeklyLimitUsd: 50,
      dailySpentUsd: 12,
      weeklySpentUsd: 20,
      dailyWindowStartIso: new Date(Date.now() - 60_000).toISOString(),
      dailyResetAtIso: new Date(Date.now() + 5 * 60_000).toISOString(),
      weeklyWindowStartIso: new Date(Date.now() - 60_000).toISOString(),
      weeklyResetAtIso: new Date(Date.now() + 7 * 60_000).toISOString(),
      dailyExceeded: true,
      weeklyExceeded: false,
    }
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { type?: string; retry_after?: number; reset_at?: string };
  };
  assert.equal(body.error.type, "invalid_request_error");
  assert.ok(body.error.reset_at);
  assert.ok(body.error.retry_after! >= 299 && body.error.retry_after! <= 300);
});

/**
 * Regression: a stale provider-limits cache must not silently demote the weekly
 * window to a rolling 7d one.
 *
 * Production incident (2026-07-30): Anthropic's OAuth usage endpoint kept
 * answering 429, so the Claude provider-limits cache stayed pinned to the
 * PREVIOUS week (`fetchAndPersistProviderLimits` keeps the prior entry on a
 * failed fetch instead of wiping it). Its `weekly (7d)` resetAt elapsed,
 * `findWeeklyQuotaResetAt` returned null, and the weekly USD window fell back to
 * `now - 7d` — which still contained the spend of the week the provider had
 * already reset. A key limited to $390/week stayed blocked at 113% with zero
 * requests since the reset. `quota_snapshots` had already observed the reset.
 */
test("weekly window follows the observed quota reset when the provider-limits cache is stale", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });

  const created = await apiKeysDb.createApiKey("Stale Cache Key", "machine-limit-stale");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 20,
  });

  // Spent in the week the provider has since reset — must NOT count anymore.
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Stale Cache Key",
    tokens: { input: 30_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  // Spent after the reset — the only spend the new window may see.
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Stale Cache Key",
    tokens: { input: 3_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-20T13:30:00.000Z",
  });

  const db = core.getDbInstance();
  const insertSnapshot = db.prepare(`
    INSERT INTO quota_snapshots (
      provider, connection_id, window_key, remaining_percentage, is_exhausted,
      next_reset_at, window_duration_ms, raw_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Last observation of the old window (nearly drained), then the reset.
  insertSnapshot.run(
    "claude",
    "conn-claude",
    "weekly (7d)",
    2,
    0,
    "2026-06-20T13:00:00.000Z",
    null,
    null,
    "2026-06-19T22:54:00.000Z"
  );
  insertSnapshot.run(
    "claude",
    "conn-claude",
    "weekly (7d)",
    100,
    0,
    "2026-06-27T13:00:00.000Z",
    null,
    null,
    "2026-06-20T13:05:00.000Z"
  );

  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    {
      now: () => Date.parse("2026-06-20T14:30:00.000Z"),
      getProviderConnectionById: async () => ({
        id: "conn-claude",
        provider: "claude",
        isActive: true,
      }),
      getProviderConnections: async () => [],
      // Frozen cache: its weekly reset already elapsed and never advanced.
      getProviderLimitsCache: () => ({
        plan: "Claude Max",
        quotas: {
          "session (5h)": { used: 2, total: 100, resetAt: "2026-06-20T18:00:00.000Z" },
          "weekly (7d)": { used: 98, total: 100, resetAt: "2026-06-20T13:00:00.000Z" },
        },
        message: null,
        fetchedAt: "2026-06-20T02:24:00.000Z",
      }),
      getAllProviderLimitsCache: () => ({}),
    }
  );

  assert.equal(
    status.weeklyResetAtIso,
    "2026-06-27T13:00:00.000Z",
    "weekly reset must come from the observed snapshot, not stay unknown"
  );
  assert.equal(
    status.weeklyWindowStartIso,
    "2026-06-20T13:05:00.000Z",
    "weekly window must start at the observed reset, not now-7d"
  );
  assert.equal(status.weeklySpentUsd, 3, "only post-reset spend counts");
  assert.equal(status.weeklyExceeded, false);
});

test("a connection whose cache never advertised a weekly window does not gain one from snapshots", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });

  const created = await apiKeysDb.createApiKey("Session Only Key", "machine-limit-session");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 20,
  });

  core
    .getDbInstance()
    .prepare(
      `
      INSERT INTO quota_snapshots (
        provider, connection_id, window_key, remaining_percentage, is_exhausted,
        next_reset_at, window_duration_ms, raw_data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      "claude",
      "conn-session",
      "weekly (7d)",
      100,
      0,
      "2026-06-27T13:00:00.000Z",
      null,
      null,
      "2026-06-20T13:05:00.000Z"
    );

  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-session"] },
    {
      now: () => Date.parse("2026-06-20T14:30:00.000Z"),
      getProviderConnectionById: async () => ({
        id: "conn-session",
        provider: "claude",
        isActive: true,
      }),
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => ({
        plan: "Claude Pro",
        quotas: { "session (5h)": { used: 2, total: 100, resetAt: "2026-06-20T18:00:00.000Z" } },
        message: null,
        fetchedAt: "2026-06-20T14:00:00.000Z",
      }),
      getAllProviderLimitsCache: () => ({}),
    }
  );

  assert.equal(status.weeklyResetAtIso, null);
  assert.equal(status.weeklyWindowStartIso, "2026-06-13T14:30:00.000Z");
});

/**
 * `resolveApiKeyWeeklyWindow` powers the Cost Explorer "since reset" range
 * (`/api/usage/analytics?range=sinceReset`). Its whole point is to expose
 * whether the window came from a real provider-observed reset or a
 * rolling-7d fallback, so the UI can tell the difference instead of labeling
 * a rolling window "since reset".
 */
test("resolveApiKeyWeeklyWindow reports isObserved=true and matches the USD quota's own weekly window", async () => {
  const created = await apiKeysDb.createApiKey("SinceReset Key", "machine-limit-since-reset");
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const weeklyResetAt = "2026-06-25T20:00:00.000Z";
  const deps = {
    now: () => NOW,
    getProviderConnectionById: async () => ({
      id: "conn-claude",
      provider: "claude",
      isActive: true,
    }),
    getProviderConnections: async () => [],
    getProviderLimitsCache: () => ({
      plan: "Claude Max",
      quotas: {
        "weekly (7d)": {
          used: 27,
          total: 100,
          resetAt: weeklyResetAt,
        },
      },
      message: null,
      fetchedAt: new Date(NOW).toISOString(),
    }),
    getAllProviderLimitsCache: () => ({}),
  };

  const resolution = await usageLimits.resolveApiKeyWeeklyWindow(
    { ...metadata, allowedConnections: ["conn-claude"] },
    deps,
    NOW
  );

  assert.equal(resolution.isObserved, true);
  assert.equal(resolution.resetAtIso, weeklyResetAt);
  assert.equal(resolution.windowStartIso, "2026-06-18T20:00:00.000Z");

  // Must be the SAME window the key's own USD quota status uses — the whole
  // point of routing "since reset" through this helper instead of
  // reimplementing day arithmetic.
  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-claude"] },
    deps
  );
  assert.equal(resolution.windowStartIso, status.weeklyWindowStartIso);
});

test("resolveApiKeyWeeklyWindow reports isObserved=false and a rolling-7d start when no provider reset has been observed", async () => {
  const created = await apiKeysDb.createApiKey(
    "SinceReset Undetermined Key",
    "machine-limit-since-reset-2"
  );
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const resolution = await usageLimits.resolveApiKeyWeeklyWindow(
    { ...metadata, allowedConnections: [] },
    {
      now: () => NOW,
      getProviderConnectionById: async () => null,
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => null,
      getAllProviderLimitsCache: () => ({}),
    },
    NOW
  );

  assert.equal(resolution.isObserved, false);
  assert.equal(resolution.resetAtIso, null);
  assert.equal(resolution.windowStartIso, usageLimits.getRollingWeekStartIso(NOW));
});

// Regression: a connection younger than the window truncated the window to the
// connection's own age. Deleting a provider connection and logging in again
// mints a NEW connection id with zero recorded reset events and no snapshots
// from the previous window, so the earliest snapshot we hold is merely when the
// connection was born — not when the provider's window opened. Treating it as
// the window start hid every day of spend before it, which both under-reported
// cost and left the weekly cap unenforced over those days.
test("a connection born mid-window still measures the cap from the provider reset", async () => {
  await localDb.updatePricing({
    claude: {
      "claude-opus-4-8": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });

  const created = await apiKeysDb.createApiKey("Fresh Conn Key", "machine-limit-fresh-conn");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 20,
  });

  // Spent INSIDE the real window (opened 2026-06-20T13:00 = reset - 7d) but
  // BEFORE this connection existed. Must still count.
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: created.id,
    apiKeyName: "Fresh Conn Key",
    tokens: { input: 30_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-22T12:00:00.000Z",
  });

  const db = core.getDbInstance();
  const insertSnapshot = db.prepare(`
    INSERT INTO quota_snapshots (
      provider, connection_id, window_key, remaining_percentage, is_exhausted,
      next_reset_at, window_duration_ms, raw_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // The ONLY snapshots this connection has: it was created on 06-24, days after
  // the window opened. No snapshot of the previous window exists for it.
  insertSnapshot.run(
    "claude",
    "conn-fresh",
    "weekly (7d)",
    40,
    0,
    "2026-06-27T13:00:00.000Z",
    null,
    null,
    "2026-06-24T10:00:00.000Z"
  );
  insertSnapshot.run(
    "claude",
    "conn-fresh",
    "weekly (7d)",
    39,
    0,
    "2026-06-27T13:00:00.000Z",
    null,
    null,
    "2026-06-24T11:00:00.000Z"
  );

  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: ["conn-fresh"] },
    {
      now: () => Date.parse("2026-06-24T14:00:00.000Z"),
      getProviderConnectionById: async () => ({
        id: "conn-fresh",
        provider: "claude",
        isActive: true,
      }),
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => ({
        plan: "Claude Max",
        quotas: {
          "weekly (7d)": { used: 60, total: 100, resetAt: "2026-06-27T13:00:00.000Z" },
        },
        message: null,
        fetchedAt: "2026-06-24T11:00:00.000Z",
      }),
      getAllProviderLimitsCache: () => ({}),
    }
  );

  assert.equal(
    status.weeklyWindowStartIso,
    "2026-06-20T13:00:00.000Z",
    "window must anchor on reset - 7d, not on when this connection first appeared"
  );
  assert.equal(status.weeklySpentUsd, 30, "spend from before the connection existed still counts");
  assert.equal(status.weeklyExceeded, true, "the cap must be enforced over the full window");
});
