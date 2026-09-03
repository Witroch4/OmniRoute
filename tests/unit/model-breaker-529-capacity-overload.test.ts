/**
 * tests/unit/model-breaker-529-capacity-overload.test.ts
 *
 * A 529 ("Overloaded") from an account-wide-quota provider must arm the per-model
 * breaker, so a storm stops being forwarded 1:1 to an upstream that is already
 * refusing everyone.
 *
 * Measured in production on 2026-09-03: 26 requests for `claude-opus-5` over three
 * minutes, every one a 529, every one forwarded — because the model-lockout path in
 * markAccountUnavailable is gated on `hasPerModelQuota`, which is FALSE for the
 * Claude subscription (its quota is account-wide). That gate is right for quota — a
 * shared quota says nothing about one model — and wrong for capacity, which is
 * model-specific by nature. Sonnet, Haiku and every other provider answered 200
 * throughout the same window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-breaker-529-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-breaker-529-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { getModelLockoutInfo, isModelLocked, clearAllModelLockouts, hasPerModelQuota } =
  await import("../../open-sse/services/accountFallback.ts");

const OVERLOAD_CAP_MS = 30_000;

/**
 * Narrows the untyped `createProviderConnection` result to the one field these
 * tests use. Asserting the shape beats casting to `any`: if the DB helper ever
 * stops returning an id, the failure names that instead of surfacing as a
 * confusing "undefined is not locked" three assertions later.
 */
async function seedConnection(provider: string): Promise<{ id: string }> {
  const created: unknown = await providersDb.createProviderConnection({
    provider,
    authType: "oauth",
    name: `${provider}-breaker-test`,
    apiKey: `sk-test-${Math.random().toString(16).slice(2, 8)}`,
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: null,
    backoffLevel: 0,
    providerSpecificData: {},
  });
  const id = (created as { id?: unknown })?.id;
  assert.equal(typeof id, "string", "seeded connection must expose a string id");
  return { id: id as string };
}

test.beforeEach(async () => {
  clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("the premise: claude has NO per-model quota, which is why the breaker never armed", () => {
  // If this ever becomes true, the fix below is redundant rather than wrong —
  // but the test should be revisited instead of silently passing for a new reason.
  assert.equal(hasPerModelQuota("claude", "claude-opus-5"), false);
});

test("a 529 arms the model breaker on an account-wide-quota provider", async () => {
  const conn = await seedConnection("claude");
  assert.equal(isModelLocked("claude", conn.id, "claude-opus-5"), false);

  await auth.markAccountUnavailable(conn.id, 529, "[529]: Overloaded", "claude", "claude-opus-5");

  assert.equal(
    isModelLocked("claude", conn.id, "claude-opus-5"),
    true,
    "529 must lock the model so the next request fails locally instead of hitting the upstream"
  );
  const info = getModelLockoutInfo("claude", conn.id, "claude-opus-5");
  assert.equal(info?.reason, "model_overloaded");
});

test("the overload lockout is capped tight — an upstream blip cannot become our outage", async () => {
  const conn = await seedConnection("claude");

  // Hammer it the way the incident did; the backoff escalates but must plateau.
  for (let i = 0; i < 12; i++) {
    await auth.markAccountUnavailable(conn.id, 529, "[529]: Overloaded", "claude", "claude-opus-5");
  }

  const info = getModelLockoutInfo("claude", conn.id, "claude-opus-5");
  assert.ok(info, "expected a lockout after repeated overloads");
  assert.ok(
    info.remainingMs <= OVERLOAD_CAP_MS,
    `overload cooldown ${info.remainingMs}ms exceeded the ${OVERLOAD_CAP_MS}ms ceiling`
  );
});

test("the breaker is model-scoped: locking opus does not touch its siblings", async () => {
  const conn = await seedConnection("claude");
  await auth.markAccountUnavailable(conn.id, 529, "[529]: Overloaded", "claude", "claude-opus-5");

  assert.equal(isModelLocked("claude", conn.id, "claude-opus-5"), true);
  assert.equal(
    isModelLocked("claude", conn.id, "claude-sonnet-5"),
    false,
    "a sibling model answering normally must stay available"
  );
  assert.equal(isModelLocked("claude", conn.id, "claude-haiku-4-5-20251001"), false);
});

test("scope is deliberately 529-only: 503 keeps its previous behaviour here", async () => {
  const conn = await seedConnection("claude");
  await auth.markAccountUnavailable(conn.id, 503, "Service Unavailable", "claude", "claude-opus-5");

  assert.equal(
    isModelLocked("claude", conn.id, "claude-opus-5"),
    false,
    "on this provider a 503 can be network/gateway rather than the model — widening the scope needs its own evidence"
  );
});

test("the lock expires on its own, so the next request is the half-open probe", async () => {
  const conn = await seedConnection("claude");
  await auth.markAccountUnavailable(conn.id, 529, "[529]: Overloaded", "claude", "claude-opus-5");

  const info = getModelLockoutInfo("claude", conn.id, "claude-opus-5");
  assert.ok(info && info.remainingMs > 0, "expected a live lockout");
  assert.ok(
    info.remainingMs <= OVERLOAD_CAP_MS,
    "a first overload must not park the model for longer than the ceiling"
  );
});
