import test from "node:test";
import assert from "node:assert/strict";

import { getLongContextUpgradeModel } from "../../open-sse/services/modelFamilyFallback.ts";
import { isLongContextCreditGateError } from "../../open-sse/services/longContextCreditGate.ts";
import { isNewerModelVersion } from "../../src/lib/usage/modelFamilyGlob.ts";

const GATE = "[429]: Usage credits are required for long context requests.";

test("isLongContextCreditGateError matches only the 429 gate wording", () => {
  assert.equal(isLongContextCreditGateError(429, GATE), true);
  assert.equal(
    isLongContextCreditGateError(429, "usage credits are REQUIRED for long context requests"),
    true
  );
  // A genuine rate limit keeps its cooldown semantics.
  assert.equal(isLongContextCreditGateError(429, "Rate limit exceeded"), false);
  assert.equal(isLongContextCreditGateError(429, "You have exhausted your usage credits"), false);
  // The gate is a 429 by contract; the same words on another status are not it.
  assert.equal(isLongContextCreditGateError(400, GATE), false);
  assert.equal(isLongContextCreditGateError(500, GATE), false);
});

test("isNewerModelVersion orders by the version digits and ignores date snapshots", () => {
  assert.equal(isNewerModelVersion("claude-sonnet-5-5", "claude-sonnet-4-6"), true);
  assert.equal(isNewerModelVersion("claude-sonnet-5-5", "claude-sonnet-5"), true);
  assert.equal(isNewerModelVersion("claude-sonnet-5", "claude-sonnet-5-5"), false);
  assert.equal(isNewerModelVersion("claude-sonnet-4-6", "claude-sonnet-4-6"), false);
  // 20250929 is a snapshot date, not a version: 4-5 stays older than 4-6.
  assert.equal(isNewerModelVersion("claude-sonnet-4-6", "claude-sonnet-4-5-20250929"), true);
  assert.equal(isNewerModelVersion("claude-sonnet-4-5-20250929", "claude-sonnet-4-6"), false);
});

test("getLongContextUpgradeModel picks the NEWEST newer sibling of the same family", () => {
  assert.equal(
    getLongContextUpgradeModel("claude", "claude-sonnet-4-6", new Set(["claude-sonnet-4-6"])),
    "claude-sonnet-5-5"
  );
  // Same pick from a dated snapshot id.
  assert.equal(
    getLongContextUpgradeModel("claude", "claude-sonnet-4-5-20250929", new Set()),
    "claude-sonnet-5-5"
  );
});

test("getLongContextUpgradeModel keeps the provider prefix shape of the input", () => {
  assert.equal(
    getLongContextUpgradeModel("claude", "claude/claude-sonnet-4-6", new Set()),
    "claude/claude-sonnet-5-5"
  );
  assert.equal(
    getLongContextUpgradeModel("claude", "cc/claude-sonnet-4-6", new Set()),
    "cc/claude-sonnet-5-5"
  );
});

test("getLongContextUpgradeModel skips tried models and walks down to the next newer one", () => {
  assert.equal(
    getLongContextUpgradeModel("claude", "claude-sonnet-4-6", new Set(["claude-sonnet-5-5"])),
    "claude-sonnet-5"
  );
  assert.equal(
    getLongContextUpgradeModel(
      "claude",
      "claude-sonnet-4-6",
      new Set(["claude-sonnet-5-5", "claude-sonnet-5"])
    ),
    null
  );
});

test("getLongContextUpgradeModel never leaves the family, never downgrades, never leaves Claude", () => {
  // Newest of the family: nothing to upgrade to.
  assert.equal(getLongContextUpgradeModel("claude", "claude-sonnet-5-5", new Set()), null);
  // A Sonnet request is never handed to an Opus (different price tier, not an overflow rule).
  const upgraded = getLongContextUpgradeModel("claude", "claude-sonnet-4-6", new Set());
  assert.match(String(upgraded), /^claude-sonnet-/);
  // The gate is Anthropic's wording; other providers' families say nothing about it.
  assert.equal(getLongContextUpgradeModel("openai", "gpt-4.1", new Set()), null);
  assert.equal(getLongContextUpgradeModel("claude", "not-a-claude-model", new Set()), null);
  assert.equal(getLongContextUpgradeModel("nope", "claude-sonnet-4-6", new Set()), null);
});
