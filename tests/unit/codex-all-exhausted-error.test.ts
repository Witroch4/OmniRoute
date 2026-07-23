import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexAllExhaustedError,
  buildCodexExhaustedStreamBody,
} from "../../open-sse/handlers/chatCore/codexFailover.ts";

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
  assert.equal(parsed.error.code, "insufficient_quota");
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

test("A(stream): exhausted body is a terminal response.failed SSE event the CLI renders", () => {
  const msg = "All Codex accounts have reached their usage limit. Earliest reset after 137h 25m.";
  const sse = buildCodexExhaustedStreamBody(msg);
  // Must be an SSE `response.failed` event (what codex-rs surfaces) + a [DONE].
  assert.match(sse, /^event: response\.failed\ndata: /);
  assert.ok(sse.includes("data: [DONE]\n\n"));
  // The data line must be valid JSON carrying the human reason.
  const dataLine = sse.split("\n").find((l) => l.startsWith("data: {"))!;
  const parsed = JSON.parse(dataLine.slice("data: ".length));
  assert.equal(parsed.type, "response.failed");
  assert.equal(parsed.response.status, "failed");
  // MUST be `insufficient_quota` — codex-rs only treats
  // context_length_exceeded / insufficient_quota / usage_not_included as
  // NON-retryable; any other code loops into "exceeded retry limit".
  assert.equal(parsed.response.error.code, "insufficient_quota");
  assert.equal(parsed.response.error.type, "insufficient_quota");
  assert.equal(parsed.response.error.message, msg);
});
