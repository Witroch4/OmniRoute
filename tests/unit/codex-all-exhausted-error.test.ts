import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexAllExhaustedError } from "../../open-sse/handlers/chatCore/codexFailover.ts";

/**
 * Fix A — when Codex account-rotation failover has no account left, the client
 * must get a clear error + a bounded Retry-After instead of the bare upstream
 * 429 that makes the Codex client retry blindly until "exceeded retry limit".
 */

const NOW = Date.UTC(2026, 6, 22, 20, 0, 0); // 2026-07-22T20:00:00Z

test("A: near reset surfaces exact Retry-After seconds + reset_at + human reason", () => {
  const resetAt = new Date(NOW + 120_000).toISOString(); // +120s
  const out = buildCodexAllExhaustedError({
    retryAfter: resetAt,
    retryAfterHuman: "reset after 2m 0s",
    now: NOW,
  });
  assert.equal(out.retryAfterSeconds, 120);
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.error.code, "codex_all_accounts_exhausted");
  assert.equal(parsed.error.type, "insufficient_quota");
  assert.equal(parsed.error.reset_at, resetAt);
  assert.match(parsed.error.message, /reset after 2m 0s/);
});

test("A: a far weekly reset is capped to 1h so the client backs off but does not wait weeks", () => {
  const resetAt = new Date(NOW + 663 * 3600 * 1000).toISOString(); // ~27 days out
  const out = buildCodexAllExhaustedError({
    retryAfter: resetAt,
    retryAfterHuman: "reset after 663h 0m",
    now: NOW,
  });
  assert.equal(out.retryAfterSeconds, 3600);
  assert.equal(JSON.parse(out.body).error.reset_at, resetAt);
});

test("A: unknown reset falls back to a 60s Retry-After and omits reset_at", () => {
  const out = buildCodexAllExhaustedError({ retryAfter: null, retryAfterHuman: null, now: NOW });
  assert.equal(out.retryAfterSeconds, 60);
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.error.reset_at, undefined);
  assert.match(parsed.error.message, /reached their usage limit/i);
});

test("A: a past reset timestamp is treated as unknown (no negative Retry-After)", () => {
  const resetAt = new Date(NOW - 5_000).toISOString();
  const out = buildCodexAllExhaustedError({ retryAfter: resetAt, now: NOW });
  assert.equal(out.retryAfterSeconds, 60);
  assert.equal(JSON.parse(out.body).error.reset_at, undefined);
});
