/**
 * Fork (min-spend guarantee / provider-quota bypass scope).
 *
 * The quota preflight parks codex per quota scope and agy/antigravity per model family — not on
 * the connection row — so the connection-level `lastErrorSource === "quota_preflight"` bypass
 * (sse-auth.test.ts) never saw those blocks: a key with the bypass scope, or with an unmet
 * min-spend guarantee, was barred by the cutoff another key's preflight put on the account.
 * The preflight now tags its cooldowns; a bypassing key routes past THOSE, never past a
 * cooldown the upstream imposed with a real 429.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-preflight-scope-bypass-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "preflight-scope-bypass-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const fallback = await import("../../open-sse/services/accountFallback.ts");
const quotaPreflight = await import("../../open-sse/services/quotaPreflight.ts");
const { persistCodexChildCooldown } = await import("../../open-sse/services/codexAccount/index.ts");
const { markAntigravityModelQuotaExhausted } =
  await import("../../open-sse/services/antigravityFamilyCooldown.ts");

const CODEX_MODEL = "gpt-5.5";
const AGY_MODEL = "gemini-3.8-flash";

type Psd = Record<string, Record<string, string> | undefined>;

async function resetStorage() {
  fallback.clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function futureIso(ms = 120_000) {
  return new Date(Date.now() + ms).toISOString();
}

async function flushWrites() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function seedOauth(provider: string, name: string) {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: "oauth",
    name,
    email: `${name}@example.test`,
    accessToken: `${name}-access`,
    refreshToken: `${name}-refresh`,
    apiKey: null,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { quotaPreflightEnabled: true },
  });
  return String((connection as { id: string }).id);
}

async function psdOf(connectionId: string): Promise<Psd> {
  const row = await providersDb.getProviderConnectionById(connectionId);
  return ((row as { providerSpecificData?: Psd } | null)?.providerSpecificData ?? {}) as Psd;
}

function exhaustedQuota(resetAt: string) {
  return {
    used: 100,
    total: 100,
    percentUsed: 1,
    resetAt,
    windows: {
      session: { percentUsed: 1, resetAt },
      gemini_weekly: { percentUsed: 1, resetAt },
    },
  };
}

/** What a request WITHOUT the bypass does: the preflight runs and parks the account. */
async function parkViaPreflight(provider: string, model: string, resetAt: string) {
  quotaPreflight.registerQuotaFetcher(provider, async () => exhaustedQuota(resetAt));
  const blocked = await auth.getProviderCredentialsWithQuotaPreflight(provider, null, null, model);
  assert.equal(
    (blocked as { allRateLimited?: boolean }).allRateLimited,
    true,
    "the preflight must park the exhausted account"
  );
}

const bypass = { bypassQuotaPolicy: true } as const;

function isBlocked(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && "allRateLimited" in result);
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  fallback.clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── Codex: per-scope cooldown ──────────────────────────────────────────────

test("codex: the preflight tags its scope cooldown; a bypassing key passes it, a normal key does not", async () => {
  const connectionId = await seedOauth("codex", "codex-preflight-park");
  const resetAt = futureIso();
  await parkViaPreflight("codex", CODEX_MODEL, resetAt);

  const psd = await psdOf(connectionId);
  assert.equal(psd.codexScopeRateLimitedUntil?.codex, resetAt);
  assert.equal(psd.codexScopeRateLimitSource?.codex, "quota_preflight");

  // (b) a key without the bypass is still barred.
  assert.equal(
    isBlocked(await auth.getProviderCredentials("codex", null, null, CODEX_MODEL)),
    true
  );

  // (a) a key with the bypass scope / unmet min-spend guarantee routes past it…
  const passed = await auth.getProviderCredentials("codex", null, null, CODEX_MODEL, bypass);
  assert.equal(isBlocked(passed), false);
  assert.equal((passed as { connectionId?: string }).connectionId, connectionId);

  // …without clearing the cooldown for everyone else.
  const after = await psdOf(connectionId);
  assert.equal(after.codexScopeRateLimitedUntil?.codex, resetAt);
  assert.equal(after.codexScopeRateLimitSource?.codex, "quota_preflight");
  assert.equal(
    isBlocked(await auth.getProviderCredentials("codex", null, null, CODEX_MODEL)),
    true
  );
});

test("codex: the bypass does not skip a scope cooldown from a real 429", async () => {
  const connectionId = await seedOauth("codex", "codex-real-429");
  await auth.markAccountUnavailable(connectionId, 429, "usage limit reached", "codex", CODEX_MODEL);

  const psd = await psdOf(connectionId);
  assert.ok(psd.codexScopeRateLimitedUntil?.codex, "a real 429 persists the scope cooldown");
  assert.notEqual(psd.codexScopeRateLimitSource?.codex, "quota_preflight");

  assert.equal(
    isBlocked(await auth.getProviderCredentials("codex", null, null, CODEX_MODEL, bypass)),
    true
  );
});

test("codex: a real 429 landing on a preflight cooldown takes ownership of it", async () => {
  const connectionId = await seedOauth("codex", "codex-preflight-then-429");
  await parkViaPreflight("codex", CODEX_MODEL, futureIso());
  assert.equal(
    isBlocked(await auth.getProviderCredentials("codex", null, null, CODEX_MODEL, bypass)),
    false
  );

  // The bypassing request reaches the provider and gets a genuine 429.
  await auth.markAccountUnavailable(connectionId, 429, "usage limit reached", "codex", CODEX_MODEL);

  assert.notEqual((await psdOf(connectionId)).codexScopeRateLimitSource?.codex, "quota_preflight");
  assert.equal(
    isBlocked(await auth.getProviderCredentials("codex", null, null, CODEX_MODEL, bypass)),
    true,
    "the real 429 must stop the bypassing key from stampeding the account"
  );
});

test("codex: the preflight never replaces an active real cooldown", async () => {
  const connectionId = await seedOauth("codex", "codex-real-then-preflight");
  const realUntil = futureIso(300_000);
  await persistCodexChildCooldown({
    connectionId,
    model: CODEX_MODEL,
    rateLimitedUntil: realUntil,
  });

  await persistCodexChildCooldown({
    connectionId,
    model: CODEX_MODEL,
    rateLimitedUntil: futureIso(60_000),
    rateLimitSource: "quota_preflight",
  });

  const psd = await psdOf(connectionId);
  assert.equal(psd.codexScopeRateLimitedUntil?.codex, realUntil);
  assert.equal(psd.codexScopeRateLimitSource?.codex, "fallback");
  assert.equal(
    isBlocked(await auth.getProviderCredentials("codex", null, null, CODEX_MODEL, bypass)),
    true
  );
});

// ─── Antigravity: per-family lock ───────────────────────────────────────────

test("agy: the preflight tags its family lock; a bypassing key passes it, a normal key does not", async () => {
  const connectionId = await seedOauth("antigravity", "agy-preflight-park");
  const resetAt = futureIso();
  await parkViaPreflight("antigravity", AGY_MODEL, resetAt);

  const psd = await psdOf(connectionId);
  assert.equal(psd.antigravityFamilyRateLimitedUntil?.gemini, resetAt);
  assert.equal(psd.antigravityFamilyRateLimitSource?.gemini, "quota_preflight");

  // (b) a key without the bypass is still barred.
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL)),
    true
  );

  // (a) a bypassing key routes past it…
  const passed = await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass);
  assert.equal(isBlocked(passed), false);
  assert.equal((passed as { connectionId?: string }).connectionId, connectionId);

  // …and the lock keeps holding for everyone else.
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL)),
    true
  );
});

test("agy: the preflight origin survives a restart (rehydrated from the connection row)", async () => {
  await seedOauth("antigravity", "agy-preflight-restart");
  await parkViaPreflight("antigravity", AGY_MODEL, futureIso());

  fallback.clearAllModelLockouts(); // a fresh process: only the persisted row is left

  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL)),
    true
  );
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    false
  );
});

test("agy: the bypass does not skip a family lock from a real quota 429", async () => {
  const connectionId = await seedOauth("antigravity", "agy-real-429");
  markAntigravityModelQuotaExhausted(connectionId, 300_000, AGY_MODEL);
  await flushWrites();

  const psd = await psdOf(connectionId);
  assert.ok(psd.antigravityFamilyRateLimitedUntil?.gemini);
  assert.equal(psd.antigravityFamilyRateLimitSource?.gemini, undefined);

  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    true
  );

  // Same after a restart: the row alone says it was imposed by the upstream.
  fallback.clearAllModelLockouts();
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    true
  );
});

test("agy: a real 429 landing on a preflight lock takes ownership of it", async () => {
  const connectionId = await seedOauth("antigravity", "agy-preflight-then-429");
  await parkViaPreflight("antigravity", AGY_MODEL, futureIso(300_000));
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    false
  );

  // The bypassing request reaches Google and is refused for real (shorter deadline than ours).
  markAntigravityModelQuotaExhausted(connectionId, 30_000, AGY_MODEL);
  await flushWrites();

  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    true,
    "the real 429 must stop the bypassing key from stampeding the account"
  );
  assert.equal(
    (await psdOf(connectionId)).antigravityFamilyRateLimitSource?.gemini,
    undefined,
    "the persisted origin flips to upstream-imposed"
  );

  fallback.clearAllModelLockouts();
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    true
  );
});

test("agy: the preflight never lays its lock over one the upstream imposed", async () => {
  const connectionId = await seedOauth("antigravity", "agy-real-then-preflight");
  markAntigravityModelQuotaExhausted(connectionId, 30_000, AGY_MODEL);
  await flushWrites();

  const { persistAntigravityPreflightFamilyLock } =
    await import("../../open-sse/services/antigravityFamilyCooldown.ts");
  await persistAntigravityPreflightFamilyLock({
    provider: "antigravity",
    connectionId,
    model: AGY_MODEL,
    unavailableUntil: futureIso(600_000),
  });

  assert.equal((await psdOf(connectionId)).antigravityFamilyRateLimitSource?.gemini, undefined);
  assert.equal(
    isBlocked(await auth.getProviderCredentials("antigravity", null, null, AGY_MODEL, bypass)),
    true
  );
});
