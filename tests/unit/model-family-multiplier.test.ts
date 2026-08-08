// Unit tests for the shared model-family multiplier resolver
// (src/lib/usage/modelFamilyMultiplier.ts) — the ONE function all three cost
// paths (apiKeyUsageLimits.ts, the analytics route, chatCore's write-time
// recordCost) must go through. Pure-function tests only; DB-backed
// integration lives in tests/unit/model-family-multiplier-agreement.test.ts.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyFamilyMultiplier,
  normalizeFamilyMultiplier,
  resolveFamilyMultiplier,
  type FamilyMultiplierRule,
} from "../../src/lib/usage/modelFamilyMultiplier.ts";

function rule(overrides: Partial<FamilyMultiplierRule> = {}): FamilyMultiplierRule {
  return {
    id: "rule-1",
    apiKeyId: "key-1",
    enabled: true,
    priority: 0,
    provider: "anthropic",
    familyGlob: "claude-opus-*",
    multiplier: 2,
    ...overrides,
  };
}

// ─── the neutral-fallback table — the single most dangerous failure mode ───
// (a 0 multiplier would make matching spend read as zero and silently
// unblock every quota on the key), so every input that isn't a genuine
// positive finite number must resolve to 1.0, never 0, never a throw.

describe("normalizeFamilyMultiplier — neutral-fallback table", () => {
  const cases: Array<[string, unknown, number]> = [
    ["absent (undefined)", undefined, 1],
    ["null", null, 1],
    ["disabled sentinel-ish empty string", "", 1],
    ["whitespace-only string", "   ", 1],
    ["zero (the dangerous one)", 0, 1],
    ["zero as a string", "0", 1],
    ["negative number", -1, 1],
    ["negative string", "-2.5", 1],
    ["NaN", Number.NaN, 1],
    ["unparseable string", "not-a-number", 1],
    ["Infinity", Number.POSITIVE_INFINITY, 1],
    ["-Infinity", Number.NEGATIVE_INFINITY, 1],
    ["a boolean", true as unknown, 1],
    ["an object", { multiplier: 2 } as unknown, 1],
  ];

  for (const [label, input, expected] of cases) {
    test(`${label} -> ${expected}`, () => {
      assert.equal(normalizeFamilyMultiplier(input), expected);
    });
  }

  test("a genuine positive number passes through unchanged", () => {
    assert.equal(normalizeFamilyMultiplier(2.5), 2.5);
  });

  test("a genuine positive number as a dot-decimal string parses", () => {
    assert.equal(normalizeFamilyMultiplier("1.5"), 1.5);
  });

  test("a genuine positive number as a comma-decimal string parses (pt-BR keyboard)", () => {
    assert.equal(normalizeFamilyMultiplier("1,5"), 1.5);
  });

  test("clamps above MAX_FAMILY_MULTIPLIER instead of applying it raw", () => {
    // A fat-fingered 150 (meant to be 1.50) must never multiply spend 150x —
    // even if it somehow reached the table bypassing write-time validation
    // (a direct DB edit, a pre-cap legacy row), this read-time clamp bounds it.
    assert.equal(normalizeFamilyMultiplier(150), 20);
  });

  test("exactly at the cap passes through unchanged", () => {
    assert.equal(normalizeFamilyMultiplier(20), 20);
  });
});

describe("resolveFamilyMultiplier — glob matching and rule selection", () => {
  test("no rules at all -> neutral", () => {
    assert.equal(resolveFamilyMultiplier([], "anthropic", "claude-opus-4-8"), 1);
  });

  test("blank provider or model -> neutral, even with matching rules present", () => {
    const rules = [rule()];
    assert.equal(resolveFamilyMultiplier(rules, "", "claude-opus-4-8"), 1);
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", ""), 1);
    assert.equal(resolveFamilyMultiplier(rules, null, "claude-opus-4-8"), 1);
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", undefined), 1);
  });

  test("a matching enabled rule applies its multiplier", () => {
    const rules = [rule({ multiplier: 3 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8"), 3);
  });

  test("matching is case-insensitive on both provider and family glob", () => {
    const rules = [rule({ provider: "Anthropic", familyGlob: "CLAUDE-OPUS-*", multiplier: 4 })];
    assert.equal(resolveFamilyMultiplier(rules, "ANTHROPIC", "Claude-Opus-4-8"), 4);
  });

  test("a disabled rule never matches", () => {
    const rules = [rule({ enabled: false, multiplier: 5 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8"), 1);
  });

  test("provider mismatch never matches, even with an identical family glob", () => {
    const rules = [rule({ provider: "openai", multiplier: 5 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8"), 1);
  });

  test("family glob mismatch never matches", () => {
    const rules = [rule({ familyGlob: "claude-sonnet-*", multiplier: 5 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8"), 1);
  });

  test("`?` matches exactly one character", () => {
    const rules = [rule({ familyGlob: "gpt-5.?", multiplier: 2 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "gpt-5.5"), 2);
    assert.equal(
      resolveFamilyMultiplier(rules, "anthropic", "gpt-5.55"),
      1,
      "? is exactly one char"
    );
  });

  test("multiple matching rules resolve by priority ascending, lowest wins", () => {
    const rules = [
      rule({ id: "b", priority: 5, multiplier: 9 }),
      rule({ id: "a", priority: 1, multiplier: 2 }),
    ];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8"), 2);
  });

  test("a tie in priority resolves deterministically by id", () => {
    const rulesAB = [
      rule({ id: "a", priority: 0, multiplier: 2 }),
      rule({ id: "b", priority: 0, multiplier: 9 }),
    ];
    const rulesBA = [
      rule({ id: "b", priority: 0, multiplier: 9 }),
      rule({ id: "a", priority: 0, multiplier: 2 }),
    ];
    // Same result regardless of input order — proves the sort, not array order, decides.
    assert.equal(resolveFamilyMultiplier(rulesAB, "anthropic", "claude-opus-4-8"), 2);
    assert.equal(resolveFamilyMultiplier(rulesBA, "anthropic", "claude-opus-4-8"), 2);
  });

  test("a stored multiplier of 0 on an otherwise-matching rule resolves through the neutral fallback, not 0", () => {
    const rules = [rule({ multiplier: 0 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8"), 1);
  });

  // ─── billed-family resolution, including the redirected case — the central
  // rule of the whole feature: a request billed as opus takes the OPUS
  // multiplier even though sonnet actually served it. Every call site passes
  // the EFFECTIVE BILLED pair in, never the served one — this test locks in
  // that the resolver itself has no way to prefer the wrong family, since it
  // only ever sees whatever pair it's handed.
  test("a redirected request (served sonnet, billed opus) takes the OPUS family's multiplier, never sonnet's", () => {
    const rules = [
      rule({ id: "opus-rule", provider: "anthropic", familyGlob: "claude-opus-*", multiplier: 5 }),
      rule({
        id: "sonnet-rule",
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: 2,
      }),
    ];
    // Caller passes the BILLED pair (opus), not the served one (sonnet) — this is the
    // contract every real call site (apiKeyUsageLimits.ts's COALESCE, the analytics
    // route's resolveRowPricingPair, chatCore's billedProviderForCost/billedModelForCost)
    // is responsible for upholding.
    const billedMultiplier = resolveFamilyMultiplier(rules, "anthropic", "claude-opus-4-8");
    assert.equal(billedMultiplier, 5, "must take the BILLED (opus) family's multiplier");

    // And if the resolver were EVER called with the served pair instead (the bug this
    // guards against), it would silently take the wrong rule — demonstrating why every
    // call site must resolve the billed pair before reaching here.
    const wrongServedMultiplier = resolveFamilyMultiplier(rules, "anthropic", "claude-sonnet-5");
    assert.equal(wrongServedMultiplier, 2, "confirms sonnet's rule is a DIFFERENT multiplier");
    assert.notEqual(billedMultiplier, wrongServedMultiplier);
  });

  test("a non-redirected direct request takes its own family's multiplier (the new behavior this feature adds)", () => {
    // "asked sonnet directly -> billed at SONNET price x multiplier" — no redirect
    // involved at all, multiplier still applies because the billed pair IS the sonnet
    // pair here.
    const rules = [rule({ familyGlob: "claude-sonnet-*", multiplier: 1.5 })];
    assert.equal(resolveFamilyMultiplier(rules, "anthropic", "claude-sonnet-5"), 1.5);
  });
});

describe("applyFamilyMultiplier", () => {
  test("scales a positive cost by the multiplier", () => {
    assert.equal(applyFamilyMultiplier(10, 2), 20);
  });

  test("a multiplier of 1 is a true no-op", () => {
    assert.equal(applyFamilyMultiplier(12.34, 1), 12.34);
  });

  test("re-normalizes an out-of-contract multiplier instead of trusting the caller blindly", () => {
    // Even if a caller passes 0 directly (bypassing resolveFamilyMultiplier), this must
    // not zero out the cost — the neutral-fallback contract is enforced here too.
    assert.equal(applyFamilyMultiplier(10, 0), 10);
    assert.equal(applyFamilyMultiplier(10, -5), 10);
  });

  test("zero or non-finite cost passes through unchanged rather than producing NaN/garbage", () => {
    assert.equal(applyFamilyMultiplier(0, 5), 0);
    assert.equal(Number.isNaN(applyFamilyMultiplier(Number.NaN, 5)), true);
  });
});
