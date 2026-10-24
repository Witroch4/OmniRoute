import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Any module reachable from src/lib/db opens a real SQLite file and runs migrations.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agy-lease-state-"));

const state = await import("../../src/sse/services/antigravityRoutingState.ts");

test.beforeEach(() => state.__resetAntigravityRoutingStateForTests());

// Fork catalog: tiers are real ids (no `-tiered` alias), so the alias examples are the retired
// Claude ids that resolve onto the live Claude 5.5 High tier (antigravityModelAliases.ts).
test("canonicalizes prefix, case and aliases onto the callable upstream id", () => {
  assert.equal(
    state.canonicalizeAntigravityExactModel("claude-sonnet-4-6"),
    "claude-sonnet-5-5-high"
  );
  assert.equal(
    state.canonicalizeAntigravityExactModel("  ANTIGRAVITY/Claude-Sonnet-5 "),
    "claude-sonnet-5-5-high"
  );
  assert.equal(
    state.canonicalizeAntigravityExactModel("agy/claude-opus-4-6-thinking"),
    "claude-opus-5-5-high"
  );
  // Tier ids are real upstream ids: never collapsed onto a shared `-tiered` id.
  assert.equal(
    state.canonicalizeAntigravityExactModel("agy/gemini-3.8-flash-low"),
    "gemini-3.8-flash-low"
  );
  assert.equal(
    state.canonicalizeAntigravityExactModel("gemini-3.7-flash-high"),
    "gemini-3.7-flash-high"
  );
  assert.equal(state.canonicalizeAntigravityExactModel("gemini-3.1-pro"), "gemini-3.1-pro");
  assert.equal(state.canonicalizeAntigravityExactModel(null), "");
});

test("a lease fences the same connection and model, and only that pair", () => {
  const first = state.tryAcquireAntigravityLease({
    connectionId: "account-a",
    requestedModel: "gemini-3.1-pro",
    requestId: "request-a",
    now: 1_000,
  });
  assert.equal(first.kind, "acquired");
  if (first.kind !== "acquired") return;
  assert.equal(first.lease.exactModel, "gemini-3.1-pro");
  assert.equal(first.lease.connectionId, "account-a");
  assert.ok(first.lease.id.startsWith("request-a:"));
  assert.equal(first.lease.retryHintAtMs, 1_000 + state.ANTIGRAVITY_LEASE_RETRY_HINT_MS);

  // Same account + same model → busy, carrying the held lease's retry hint.
  assert.deepEqual(
    state.tryAcquireAntigravityLease({
      connectionId: "account-a",
      requestedModel: "gemini-3.1-pro",
      now: 1_001,
    }),
    { kind: "busy", retryHintAtMs: first.lease.retryHintAtMs }
  );

  // A different account for the same model is free.
  assert.equal(
    state.tryAcquireAntigravityLease({
      connectionId: "account-b",
      requestedModel: "gemini-3.1-pro",
      now: 1_001,
    }).kind,
    "acquired"
  );

  // A different upstream model on the SAME account is free: the lease scopes a
  // (connection, model) pair, it does not serialize the whole account.
  assert.equal(
    state.tryAcquireAntigravityLease({
      connectionId: "account-a",
      requestedModel: "gemini-3.7-flash-high",
      now: 1_001,
    }).kind,
    "acquired"
  );
});

test("aliases of one upstream model contend for the same lease", () => {
  const held = state.tryAcquireAntigravityLease({
    connectionId: "account-a",
    requestedModel: "claude-sonnet-4-6",
    requestId: "request-a",
    now: 1_000,
  });
  assert.equal(held.kind, "acquired");
  if (held.kind !== "acquired") return;

  // `claude-sonnet-4-6` and `claude-sonnet-5` are two catalog names for claude-sonnet-5-5-high.
  assert.deepEqual(
    state.getAntigravityLeaseAvailability({
      connectionId: "account-a",
      requestedModel: "claude-sonnet-5",
    }),
    { available: false, retryHintAtMs: held.lease.retryHintAtMs }
  );
  assert.deepEqual(
    state.getAntigravityLeaseAvailability({
      connectionId: "account-a",
      requestedModel: "antigravity/claude-sonnet-5-5-high",
    }),
    { available: false, retryHintAtMs: held.lease.retryHintAtMs }
  );
  // A genuinely different upstream model is untouched.
  assert.deepEqual(
    state.getAntigravityLeaseAvailability({
      connectionId: "account-a",
      requestedModel: "gemini-3.1-pro",
    }),
    { available: true }
  );
});

test("release is fenced by lease id and restores availability", () => {
  const acquired = state.tryAcquireAntigravityLease({
    connectionId: "account-a",
    requestedModel: "claude-sonnet-4-6",
    requestId: "request-a",
    now: 1_000,
  });
  assert.equal(acquired.kind, "acquired");
  if (acquired.kind !== "acquired") return;

  // A foreign / stale id must not free somebody else's lease.
  assert.equal(state.releaseAntigravityLease("wrong-lease"), false);
  assert.equal(state.releaseAntigravityLease(null), false);
  assert.equal(
    state.getAntigravityLeaseAvailability({
      connectionId: "account-a",
      requestedModel: "claude-sonnet-5",
    }).available,
    false
  );

  assert.equal(state.releaseAntigravityLease(acquired.lease.id), true);
  assert.deepEqual(
    state.getAntigravityLeaseAvailability({
      connectionId: "account-a",
      requestedModel: "claude-sonnet-5",
    }),
    { available: true }
  );

  // Double release is a no-op, and a late release cannot free the NEXT holder.
  const second = state.tryAcquireAntigravityLease({
    connectionId: "account-a",
    requestedModel: "claude-sonnet-5",
    requestId: "request-b",
    now: 2_000,
  });
  assert.equal(second.kind, "acquired");
  assert.equal(state.releaseAntigravityLease(acquired.lease.id), false);
  assert.equal(
    state.getAntigravityLeaseAvailability({
      connectionId: "account-a",
      requestedModel: "claude-sonnet-4-6",
    }).available,
    false
  );
});
