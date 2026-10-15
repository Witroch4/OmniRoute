import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-limits-recovery-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-provider-limits-recovery-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function withMockedFetch(fetchImpl: typeof fetch, fn: () => Promise<void>) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function createGlmConnectionWithTransientCooldown() {
  return providersDb.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    name: `GLM Recovery ${Date.now()}`,
    apiKey: "glm-test-key",
    testStatus: "unavailable",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    lastError: "rate limit exceeded",
    lastErrorType: "rate_limited",
    lastErrorSource: "executor",
    errorCode: 429,
    backoffLevel: 2,
  });
}

function glmQuotaResponse() {
  // Mirrors open-sse/services/usage/glm.ts: TOKENS_LIMIT window with remaining.
  return new Response(
    JSON.stringify({
      code: 200,
      success: true,
      data: {
        planName: "max",
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 13,
            nextResetTime: Math.floor(Date.now() / 1000) + 3 * 3600,
            models: [],
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("successful GLM quota refresh clears transient rate-limit state", async () => {
  const connection = await createGlmConnectionWithTransientCooldown();
  const connectionId = (connection as { id: string }).id;

  await withMockedFetch(
    (() => glmQuotaResponse()) as typeof fetch,
    async () => {
      await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    }
  );

  const updated = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(updated.testStatus, "active", "testStatus should be reset to active");
  assert.equal(updated.rateLimitedUntil, undefined, "rateLimitedUntil should be cleared");
  assert.equal(updated.errorCode, undefined, "errorCode should be cleared");
  assert.equal(updated.lastErrorType, undefined, "lastErrorType should be cleared");
  assert.equal(updated.backoffLevel, 0, "backoffLevel should be reset to 0");
});

async function createGlmConnectionWithStatus(status: string) {
  return providersDb.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    name: "GLM " + status + " " + Date.now(),
    apiKey: "glm-test-key",
    testStatus: status,
    lastError: "permanent failure",
    lastErrorType: "permanent",
    errorCode: 403,
    backoffLevel: 1,
  });
}

test("successful quota refresh does not clear terminal credits_exhausted status", async () => {
  const connection = await createGlmConnectionWithStatus("credits_exhausted");
  const connectionId = (connection as { id: string }).id;

  await withMockedFetch(
    (() => glmQuotaResponse()) as typeof fetch,
    async () => {
      await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    }
  );

  const updated = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(updated.testStatus, "credits_exhausted");
  assert.equal(updated.lastErrorType, "permanent");
});

test("successful quota refresh does not clear terminal banned status", async () => {
  const connection = await createGlmConnectionWithStatus("banned");
  const connectionId = (connection as { id: string }).id;

  await withMockedFetch(
    (() => glmQuotaResponse()) as typeof fetch,
    async () => {
      await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    }
  );

  const updated = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(updated.testStatus, "banned");
});

test("successful quota refresh does not clear terminal expired status", async () => {
  const connection = await createGlmConnectionWithStatus("expired");
  const connectionId = (connection as { id: string }).id;

  await withMockedFetch(
    (() => glmQuotaResponse()) as typeof fetch,
    async () => {
      await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    }
  );

  const updated = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(updated.testStatus, "expired");
});

test("Codex stale quota fallback preserves banked reset credits", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: `Codex Banked Credits ${Date.now()}`,
    accessToken: "codex-access-token",
    refreshToken: "codex-refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const connectionId = (connection as { id: string }).id;

  providerLimitsDb.setProviderLimitsCache(connectionId, {
    quotas: { session: { used: 10, total: 100, remainingPercentage: 90 } },
    plan: "pro",
    message: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "scheduled",
    bankedResetCredits: 2,
  });

  await withMockedFetch(
    (() => new Response("server unavailable", { status: 500 })) as typeof fetch,
    async () => {
      const result = await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");

      assert.equal(result.usage._stale, true);
      assert.equal(result.usage.bankedResetCredits, 2);
      assert.deepEqual(result.usage.quotas, {
        session: { used: 10, total: 100, remainingPercentage: 90 },
      });
    }
  );
});

test("error-only quota response does not clear transient state", async () => {
  const connection = await createGlmConnectionWithTransientCooldown();
  const connectionId = (connection as { id: string }).id;

  await withMockedFetch(
    (() =>
      new Response(JSON.stringify({ message: "GLM quota API error (429)" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      // The live GLM usage path throws on a 429 (it does not return an error
      // envelope), so the fetch rejects. The transient-state assertions below then
      // confirm the throw happened BEFORE maybeClearRecoveredQuotaState — i.e. an
      // errored refresh never clears the connection's cooldown.
      await assert.rejects(
        () => providerLimits.fetchAndPersistProviderLimits(connectionId, "manual"),
        /429/
      );
    }
  );

  const updated = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(updated.testStatus, "unavailable", "transient state should not be cleared on error");
  assert.equal(updated.lastErrorType, "rate_limited");
});

test("CAS primitive clears when expected state matches", async () => {
  const created = await createGlmConnectionWithTransientCooldown();
  const connectionId = (created as { id: string }).id;
  const before = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;

  const applied = await providersDb.clearConnectionErrorIfUnchanged(connectionId, {
    testStatus: (before.testStatus as string) ?? null,
    lastErrorAt: (before.lastErrorAt as string) ?? null,
    rateLimitedUntil: (before.rateLimitedUntil as string) ?? null,
  });

  assert.equal(applied, true, "CAS UPDATE should apply when expected state matches");
  const after = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(after.testStatus, "active");
  assert.equal(after.rateLimitedUntil, undefined);
  assert.equal(after.backoffLevel, 0);
});

test("CAS primitive aborts when state changed concurrently", async () => {
  const created = await createGlmConnectionWithTransientCooldown();
  const connectionId = (created as { id: string }).id;
  const before = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;

  // Simulate a concurrent markAccountUnavailable writing a fresh error state.
  const newLastErrorAt = new Date(Date.now() + 1000).toISOString();
  const newRateLimitedUntil = new Date(Date.now() + 120_000).toISOString();
  await providersDb.updateProviderConnection(connectionId, {
    lastErrorAt: newLastErrorAt,
    rateLimitedUntil: newRateLimitedUntil,
    lastError: "fresh 429",
    errorCode: 429,
    backoffLevel: 3,
  });

  const applied = await providersDb.clearConnectionErrorIfUnchanged(connectionId, {
    testStatus: (before.testStatus as string) ?? null,
    lastErrorAt: (before.lastErrorAt as string) ?? null,
    rateLimitedUntil: (before.rateLimitedUntil as string) ?? null,
  });

  assert.equal(applied, false, "CAS UPDATE should abort when state changed");
  const after = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  assert.equal(after.testStatus, "unavailable", "fresh mark should be preserved");
  assert.equal(after.backoffLevel, 3, "fresh backoff level should be preserved");
  assert.equal(after.lastError, "fresh 429");
});

test("quota recovery path does NOT overwrite a concurrent mark (TOCTOU closed)", async () => {
  const created = await createGlmConnectionWithTransientCooldown();
  const connectionId = (created as { id: string }).id;
  const snapshotBeforeClear = (await providersDb.getProviderConnectionById(
    connectionId
  )) as Record<string, unknown>;
  const expectedLastErrorAt = (snapshotBeforeClear.lastErrorAt as string) ?? null;

  // Mock fetch so that DURING the quota fetch (between read and clear), a
  // concurrent mark writes a fresh error state. This deterministically
  // reproduces the TOCTOU window the CAS primitive is meant to close.
  const concurrentMarkFetch = (() => {
    // Simulate concurrent markAccountUnavailable writing fresh state.
    providersDb.updateProviderConnection(connectionId, {
      lastErrorAt: new Date(Date.now() + 1000).toISOString(),
      rateLimitedUntil: new Date(Date.now() + 120_000).toISOString(),
      lastError: "fresh concurrent 429",
      errorCode: 429,
      backoffLevel: 3,
    });
    return glmQuotaResponse();
  }) as typeof fetch;

  await withMockedFetch(concurrentMarkFetch, async () => {
    await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
  });

  const after = (await providersDb.getProviderConnectionById(connectionId)) as Record<
    string,
    unknown
  >;
  // Recovery should have aborted (CAS miss) — fresh mark must survive.
  assert.notEqual(
    after.lastErrorAt,
    expectedLastErrorAt,
    "fresh lastErrorAt must not be overwritten by recovery clear"
  );
  assert.equal(after.testStatus, "unavailable", "fresh testStatus must survive");
  assert.equal(after.backoffLevel, 3, "fresh backoff level must survive");
  assert.equal(after.lastError, "fresh concurrent 429");
});

// --- credits_exhausted that renews with the month (GitHub Copilot) ---------------------

const COPILOT_RESET = "2026-11-01T00:00:00.000Z";

async function createCopilotConnectionExhausted(lastErrorType: string = "quota_exhausted") {
  return providersDb.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: `Copilot ${lastErrorType} ${Date.now()}`,
    accessToken: "ghu_test_token",
    testStatus: "credits_exhausted",
    lastError: "[402]: You have exceeded your monthly quota",
    lastErrorType,
    lastErrorSource: "provider_response",
    errorCode: 402,
    backoffLevel: 0,
  });
}

/** Mirrors GET api.github.com/copilot_internal/user for a Pro+ plan. */
function copilotUserResponse(premiumRemaining: number) {
  return new Response(
    JSON.stringify({
      copilot_plan: "individual_pro_plus",
      quota_reset_date: "2026-11-01",
      quota_snapshots: {
        premium_interactions: { entitlement: 1500, remaining: premiumRemaining, unlimited: false },
        chat: { entitlement: 100, remaining: 100, unlimited: true },
        completions: { entitlement: 100, remaining: 100, unlimited: true },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function syncCopilot(connectionId: string, premiumRemaining: number) {
  const mockedFetch: typeof fetch = async () => copilotUserResponse(premiumRemaining);
  await withMockedFetch(mockedFetch, async () => {
    await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
  });
  return (await providersDb.getProviderConnectionById(connectionId)) as Record<string, unknown>;
}

test("hasRenewedFiniteQuota ignores unlimited windows and vetoes on an empty finite one", () => {
  const { hasRenewedFiniteQuota } = providerLimits;

  assert.equal(
    hasRenewedFiniteQuota({
      quotas: {
        premium_interactions: { remaining: 1494, total: 1500, resetAt: COPILOT_RESET },
        chat: { remaining: 100, total: 100, unlimited: true, resetAt: COPILOT_RESET },
      },
    }),
    true
  );
  // The pool that caused the 402 is still empty; the unlimited chat window must not hide it.
  assert.equal(
    hasRenewedFiniteQuota({
      quotas: {
        premium_interactions: { remaining: 0, total: 1500, resetAt: COPILOT_RESET },
        chat: { remaining: 100, total: 100, unlimited: true, resetAt: COPILOT_RESET },
      },
    }),
    false
  );
  // Only unlimited windows: nothing says the exhausted pool renewed.
  assert.equal(
    hasRenewedFiniteQuota({ quotas: { chat: { remaining: 100, unlimited: true } } }),
    false
  );
  // A balance without a reset is not a renewed quota.
  assert.equal(hasRenewedFiniteQuota({ quotas: { credits: { remaining: 12.5, total: 20 } } }), false);
  assert.equal(hasRenewedFiniteQuota({}), false);
});

test("credits_exhausted from a quota 402 recovers once the finite window renewed", async () => {
  const connection = await createCopilotConnectionExhausted();
  const connectionId = (connection as { id: string }).id;

  const updated = await syncCopilot(connectionId, 1494);

  assert.equal(updated.testStatus, "active");
  assert.equal(updated.errorCode, undefined);
  assert.equal(updated.lastErrorType, undefined);
  assert.equal(updated.rateLimitedUntil, undefined);
});

test("credits_exhausted stays while the premium pool is still empty (no flip-flop)", async () => {
  const connection = await createCopilotConnectionExhausted();
  const connectionId = (connection as { id: string }).id;

  const updated = await syncCopilot(connectionId, 0);

  assert.equal(updated.testStatus, "credits_exhausted");
  assert.equal(updated.lastErrorType, "quota_exhausted");
});

test("credits_exhausted whose recorded cause was not a quota is left alone", async () => {
  const connection = await createCopilotConnectionExhausted("permanent");
  const connectionId = (connection as { id: string }).id;

  const updated = await syncCopilot(connectionId, 1494);

  assert.equal(updated.testStatus, "credits_exhausted");
  assert.equal(updated.lastErrorType, "permanent");
});
