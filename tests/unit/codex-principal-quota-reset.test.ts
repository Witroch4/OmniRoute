import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "om-codex-principal-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "principal-reset-test";
const core = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const providers = await import("../../src/lib/db/providers.ts");
const limitsCache = await import("../../src/lib/db/providerLimits.ts");
const limits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const command = await import("../../src/lib/usage/internalUsageCommand.ts");
const resetEvents = await import("../../src/lib/db/quotaResetEvents.ts");
const pricing = await import("../../src/lib/db/settings/pricing.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const schema = await import("../../src/shared/validation/settingsSchemas.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const now = Date.parse("2026-10-13T16:00:00.000Z");
const start = "2026-10-13T05:01:45.673Z";
const nextReset = "2026-10-20T11:53:07.000Z";
const week = 7 * 24 * 60 * 60_000;
let principalId: string;
let goId: string;

function snapshot(id: string, remaining: number, resetAt: string, observedAt: string) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO quota_snapshots
    (provider,connection_id,window_key,remaining_percentage,is_exhausted,next_reset_at,created_at)
    VALUES ('codex',?,'session',?,0,?,?)`
    )
    .run(id, remaining, resetAt, observedAt);
}

function cost(keyId: string, value: number, at: string, connectionId = principalId) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO usage_history
    (api_key_id,provider,model,connection_id,tokens_input,success,timestamp)
    VALUES (?,'codex','quota-test',?,?,1,?)`
    )
    .run(keyId, connectionId, value * 1_000_000, at);
}

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  await pricing.updatePricing({ codex: { "quota-test": { input: 1, output: 1 } } });
  goId = (
    await providers.createProviderConnection({
      provider: "codex",
      name: "Go",
      priority: 1,
      isActive: true,
    })
  ).id;
  principalId = (
    await providers.createProviderConnection({
      provider: "codex",
      name: "Prolite",
      priority: 2,
      isActive: true,
      quotaWindowThresholds: { session: 10 },
    })
  ).id;
  const claude = await providers.createProviderConnection({
    provider: "claude",
    name: "Claude",
    isActive: true,
  });
  for (const [id, plan, quotas] of [
    [goId, "go", { session: { used: 100, total: 100, resetAt: "2026-11-10T09:19:35.000Z" } }],
    [principalId, "prolite", { session: { used: 7, total: 100, resetAt: nextReset } }],
    [claude.id, "max", { weekly: { used: 50, total: 100, resetAt: "2026-10-15T22:59:59.000Z" } }],
  ] as const)
    limitsCache.setProviderLimitsCache(id, {
      plan,
      quotas,
      message: null,
      fetchedAt: "2026-10-13T15:00:00.000Z",
    });
  await settings.updateSettings({
    providerQuotaResetReferences: {
      codex: { connectionId: principalId, windowKey: "session", windowDurationMs: week },
    },
  });
  snapshot(principalId, 57, "2026-10-18T08:04:01.000Z", "2026-10-13T03:29:37.357Z");
  snapshot(principalId, 100, "2026-10-20T05:01:45.000Z", start);
  snapshot(principalId, 99, nextReset, "2026-10-13T12:01:51.058Z");
  snapshot(principalId, 90, nextReset, "2026-10-13T15:59:00.000Z");
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("original authenticated HTTP command and the USD policy share the principal window", async () => {
  const key = await apiKeys.createApiKey("Codex limit", "test-machine");
  await apiKeys.updateApiKeyPermissions(key.id, {
    allowedModels: ["codex/*", "cx/*"],
    allowUsageCommand: true,
    usageLimitEnabled: true,
    weeklyUsageLimitUsd: 100,
  });
  apiKeys.clearApiKeyCaches();
  cost(key.id, 150, "2026-10-13T04:00:00.000Z", goId);
  cost(key.id, 3, "2026-10-13T06:00:00.000Z", goId);
  cost(key.id, 4, "2026-10-13T07:00:00.000Z");
  const request = new Request("http://localhost/api/usage/om-usage?provider=codex", {
    headers: { Authorization: `Bearer ${key.key}` },
  });
  const response = await command.handleInternalUsageCommandHttpRequest(request, { now: () => now });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Personal quota[\s\S]*Weekly\n93% left/);
  const metadata = await apiKeys.getApiKeyMetadata(key.key);
  assert.ok(metadata);
  assert.equal(await limits.buildApiKeyUsageLimitPolicyRejection(request, metadata), null);
  cost(key.id, 94, "2026-10-13T08:00:00.000Z", goId);
  // Non-Anthropic callers get 429 + reset timing since upstream 3.8.53 (#14188); only the
  // Anthropic /v1/messages envelope keeps 400 (Claude Code re-login guard).
  assert.equal((await limits.buildApiKeyUsageLimitPolicyRejection(request, metadata))?.status, 429);
});

test("a timestamp adjustment without replenishment keeps the already observed principal start", async () => {
  const adjusted = "2026-10-21T11:53:07.000Z";
  resetEvents.recordProviderQuotaResetEventIfChanged({
    provider: "codex",
    connectionId: principalId,
    windowKey: "session",
    currentResetAt: adjusted,
    currentRemainingPercentage: 89,
    previousObservation: { resetAt: nextReset, remainingPercentage: 90 },
    observedAt: "2026-10-13T15:59:30.000Z",
  });
  snapshot(principalId, 89, adjusted, "2026-10-13T15:59:30.000Z");
  const status = await limits.getApiKeyUsageLimitStatus(
    { id: "jean", allowedModels: ["codex/*"] },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
  assert.equal(
    core
      .getDbInstance()
      .prepare("SELECT COUNT(*) count FROM provider_quota_reset_events WHERE connection_id=?")
      .get(principalId)?.count,
    0
  );
});

test("missing or inactive configured principal does not silently fall back to Go or Claude", async () => {
  await providers.updateProviderConnection(principalId, { isActive: false });
  await assert.rejects(
    limits.getApiKeyUsageLimitStatus(
      { id: "jean", allowedModels: ["codex/*"] },
      { now: () => now }
    ),
    /missing or inactive/
  );
  await assert.rejects(
    command.buildUsageCommandText(
      { id: "jean", allowedModels: ["codex/*"] },
      { now: () => now },
      { preferredProvider: "codex" }
    ),
    /missing or inactive/
  );
});

test("management settings accept a reference and reject malformed periods", () => {
  assert.equal(
    schema.updateSettingsSchema.safeParse({
      providerQuotaResetReferences: {
        codex: { connectionId: principalId, windowKey: "session", windowDurationMs: week },
      },
    }).success,
    true
  );
  for (const duration of [0, -1, NaN, week + 0.5])
    assert.equal(
      schema.updateSettingsSchema.safeParse({
        providerQuotaResetReferences: {
          codex: { connectionId: principalId, windowKey: "session", windowDurationMs: duration },
        },
      }).success,
      false
    );
});

test("all Codex keys reset at the principal observation and aggregate post-reset USD", async () => {
  for (const id of ["jean", "another-key"]) {
    cost(id, 120, "2026-10-13T04:00:00.000Z");
    cost(id, 3, "2026-10-13T06:00:00.000Z");
    cost(id, 4, "2026-10-13T07:00:00.000Z", goId);
    const status = await limits.getApiKeyUsageLimitStatus(
      { id, allowedModels: ["cx/*", "codex/*"], usageLimitEnabled: true, weeklyUsageLimitUsd: 100 },
      { now: () => now }
    );
    assert.equal(status.weeklyWindowStartIso, start);
    assert.equal(status.weeklyResetAtIso, nextReset);
    assert.equal(status.weeklySpentUsd, 7);
    assert.equal(status.weeklyExceeded, false);
    const window = await limits.resolveApiKeyWeeklyWindow(
      { id, allowedModels: ["codex/*"] },
      { now: () => now },
      now
    );
    assert.equal(window.windowStartIso, start);
  }
});

test("keys containing unprefixed copies of Codex models follow the same principal", async () => {
  const status = await limits.getApiKeyUsageLimitStatus(
    {
      id: "legacy-model-list",
      allowedModels: [
        "cx/codex-auto-review",
        "codex/codex-auto-review",
        "codex-auto-review",
        "cx/gpt-5.5",
        "codex/gpt-5.5",
        "gpt-5.5",
      ],
    },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
  assert.equal(status.weeklyResetAtIso, nextReset);
});

test("unchanged command follows principal over exhausted first account and uses fresh snapshot", async () => {
  const text = await command.buildUsageCommandText(
    { id: "jean", allowedModels: ["codex/*"] },
    { now: () => now },
    { preferredProvider: "codex" }
  );
  assert.match(text, /Session\n89% left/);
  assert.match(text, /Weekly\n89% left/);
  assert.doesNotMatch(text, /27d|Weekly\nUnavailable/);
});

test("explicit Go inspection preserves principal personal USD cycle", async () => {
  cost("jean", 90, "2026-10-13T04:00:00.000Z");
  cost("jean", 7, "2026-10-13T06:00:00.000Z");
  const text = await command.buildUsageCommandText(
    { id: "jean", allowedModels: ["codex/*"], usageLimitEnabled: true, weeklyUsageLimitUsd: 100 },
    {
      now: () => now,
      getApiKeyUsageLimitStatus: (metadata) =>
        limits.getApiKeyUsageLimitStatus(metadata, { now: () => now }),
    },
    { preferredProvider: "codex", preferredConnectionId: goId }
  );
  assert.match(text, /Personal quota[\s\S]*Weekly\n93% left/);
  assert.match(text, /Provider quota\nSession\n0% left/);
});

test("Go-only key uses provider principal reset without gaining inference access", async () => {
  const status = await limits.getApiKeyUsageLimitStatus(
    { id: "go-only", allowedConnections: [goId], allowedModels: ["codex/*"] },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
  assert.equal(status.weeklyResetAtIso, nextReset);
});

test("connection-only Codex keys with unrestricted models still reset with Prolite", async () => {
  const status = await limits.getApiKeyUsageLimitStatus(
    { id: "connection-only", allowedModels: [], allowedConnections: [goId] },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
});

test("a qualified wildcard cannot claim an unrelated unprefixed model's provider", async () => {
  const status = await limits.getApiKeyUsageLimitStatus(
    {
      id: "mixed-permissions",
      allowedModels: ["cc/*", "codex-auto-review"],
      allowedConnections: [goId],
    },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
  assert.equal(status.weeklyResetAtIso, nextReset);
});

test("unchanged percentage with a moved expiry is persisted without erasing prior spend", async (t) => {
  // setQuotaCache stamps the snapshot and the reset-event observation with the wall clock.
  // The scenario is an expiry moved while the 2026-10-20 window is still running, so the
  // observation must happen at the fixture's `now`: observed after 2026-10-20 the same move
  // is (correctly) a window roll that starts the budget at the old expiry.
  t.mock.timers.enable({ apis: ["Date"], now });
  quotaCache.setQuotaCache(principalId, "codex", {
    session: { used: 10, total: 100, resetAt: nextReset },
  });
  const adjusted = "2026-10-21T11:53:07.000Z";
  quotaCache.setQuotaCache(principalId, "codex", {
    session: { used: 10, total: 100, resetAt: adjusted },
  });
  const row = core
    .getDbInstance()
    .prepare(
      "SELECT next_reset_at FROM quota_snapshots WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
    )
    .get(principalId);
  assert.equal(row?.next_reset_at, adjusted);
  const status = await limits.getApiKeyUsageLimitStatus(
    { id: "jean", allowedModels: ["codex/*"] },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
});

test("a newer cache-only timestamp shift cannot manufacture a future budget start", async () => {
  const old = limitsCache.getProviderLimitsCache(principalId);
  assert.ok(old);
  limitsCache.setProviderLimitsCache(principalId, {
    ...old,
    quotas: { session: { used: 10, total: 100, resetAt: "2026-10-21T11:53:07.000Z" } },
    fetchedAt: "2026-10-13T15:59:30.000Z",
  });
  const status = await limits.getApiKeyUsageLimitStatus(
    { id: "jean", allowedModels: ["codex/*"] },
    { now: () => now }
  );
  assert.equal(status.weeklyWindowStartIso, start);
});

test("Codex without a reference never borrows Claude weekly reset", async () => {
  await settings.updateSettings({ providerQuotaResetReferences: {} });
  const status = await limits.getApiKeyUsageLimitStatus(
    { id: "jean", allowedModels: ["codex/*"] },
    { now: () => now }
  );
  assert.equal(status.weeklyResetAtIso, null);
});

test("subsequent early principal reset is persisted at observation rather than future old expiry", () => {
  const observedAt = "2026-10-13T16:00:00.000Z";
  resetEvents.recordProviderQuotaResetEventIfChanged({
    provider: "codex",
    connectionId: principalId,
    windowKey: "session",
    currentResetAt: "2026-10-20T16:00:00.000Z",
    currentRemainingPercentage: 100,
    previousObservation: { resetAt: nextReset, remainingPercentage: 90 },
    observedAt,
  });
  const row = core
    .getDbInstance()
    .prepare("SELECT window_started_at FROM provider_quota_reset_events WHERE connection_id=?")
    .get(principalId);
  assert.equal(row?.window_started_at, observedAt);
});
