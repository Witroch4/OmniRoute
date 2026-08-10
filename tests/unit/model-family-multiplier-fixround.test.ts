// Fix-round tests for the reviewer's two Important findings on the model-family
// multiplier feature (migration 128):
//
//   Finding 1 — path 3 (domain_cost_history, write-time-frozen) used to disagree with
//   paths 1-2 (usage_history, read-time) whenever a multiplier was raised AFTER
//   traffic already happened. Fixed by moving apiKeySelfService.ts and apiKeyPolicy.ts's
//   Check 4 off domain_cost_history entirely, onto async checkBudgetNormalized/
//   getCostSummaryNormalized (costRules.ts), which re-derive live from usage_history via
//   the same cached shared resolver (getApiKeyUsdSpendSinceCached, apiKeyUsageLimits.ts).
//
//   Finding 2 — the analytics route only applied a per-row multiplier to `byApiKey`
//   (which always carried real api_key_id); every other bucket only did so when the
//   request happened to be scoped to exactly one filtered key, so an unfiltered
//   response could show byApiKey.normalizedCost disagreeing with byModel.normalizedCost
//   for the identical underlying traffic. Fixed by adding api_key_id as a GROUP BY
//   dimension to every relevant usageAnalytics.ts query and resolving the multiplier
//   per SQL row everywhere, with an explicit normalizedCostCoverage flag for the one
//   remaining gap (rows rolled up into daily_usage_summary lose key attribution by
//   design and cannot be attributed at all).
//
// See tests/unit/model-family-multiplier-agreement.test.ts for the ORIGINAL agreement
// suite (round 1) — it wrote rules BEFORE spend and asserted path 3 only at the
// recordCost() call argument, which is exactly what would NOT have caught Finding 1.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-family-multiplier-fixround-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "family-multiplier-fixround-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const costRules = await import("../../src/domain/costRules.ts");
const analyticsRoute = await import("../../src/app/api/usage/analytics/route.ts");
const familyMultipliersDb = await import("../../src/lib/db/apiKeyModelFamilyMultipliers.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
  costRules.resetCostData();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function makeRequest(url: string) {
  return new Request(url, { method: "GET" });
}

function assertClose(actual: number, expected: number, epsilon = 0.0001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test.beforeEach(async () => {
  await resetStorage();
  await localDb.updatePricing({
    anthropic: {
      "claude-sonnet-5": { input: 3, output: 15 },
    },
  });
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// 1M input + 0.5M output @ $3/$15 per 1M = $10.50
const SONNET_COST = 3 * 1 + 15 * 0.5;

describe("Finding 1 fix — a multiplier raised AFTER spend already exists is retroactive on ALL THREE paths, including the enforcement/self-service read surfaces", () => {
  test("getApiKeyUsdSpendSince, the analytics route, and getCostSummaryNormalized/checkBudgetNormalized all agree before AND after the mutation", async () => {
    const apiKey = await apiKeysDb.createApiKey("Retroactive Key", "machine-fixround-01");
    costRules.setBudget(apiKey.id, {
      monthlyLimitUsd: 100,
      resetInterval: "monthly",
      warningThreshold: 0.8,
    });

    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKeyId: apiKey.id,
      apiKeyName: "Retroactive Key",
      connectionId: "fixround-conn-01",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // ── Before any multiplier: all three paths read the plain real cost ──
    const spendBefore = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso);
    assertClose(spendBefore, SONNET_COST);

    const analyticsBefore = await analyticsRoute.GET(
      makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
    );
    const bodyBefore = (await analyticsBefore.json()) as {
      byApiKey: Array<{ apiKeyId: string | null; normalizedCost: number }>;
    };
    const beforeEntry = bodyBefore.byApiKey.find((k) => k.apiKeyId === apiKey.id);
    assert.ok(beforeEntry);
    assertClose(beforeEntry.normalizedCost, SONNET_COST);

    const summaryBefore = await costRules.getCostSummaryNormalized(apiKey.id);
    assertClose(summaryBefore.totalCostMonth, SONNET_COST);
    const budgetCheckBefore = await costRules.checkBudgetNormalized(apiKey.id, 0);
    assertClose(budgetCheckBefore.periodUsed, SONNET_COST);

    assertClose(spendBefore, beforeEntry.normalizedCost);
    assertClose(beforeEntry.normalizedCost, summaryBefore.totalCostMonth);
    assertClose(summaryBefore.totalCostMonth, budgetCheckBefore.periodUsed);

    // ── The operator raises a multiplier NOW, after the traffic already happened ──
    familyMultipliersDb.replaceFamilyMultipliers(apiKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: 1.5,
      },
    ]);
    // checkBudgetNormalized/getCostSummaryNormalized read through a 60s TTL cache
    // (getApiKeyUsdSpendSinceCached) on purpose — bounding the cost of a live
    // per-request enforcement gate. Clearing it here simulates "60 seconds later",
    // not a cache bug: the fix's contract is "at most one TTL window stale", never
    // "instant", and never "up to a month" the way the old write-time column was.
    usageLimits.clearApiKeyNormalizedSpendCacheForTests();

    const expectedNormalized = SONNET_COST * 1.5; // 15.75

    // ── After: all three paths move to the SAME new figure, together ──
    const spendAfter = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso);
    assertClose(spendAfter, expectedNormalized);

    const analyticsAfter = await analyticsRoute.GET(
      makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
    );
    const bodyAfter = (await analyticsAfter.json()) as {
      byApiKey: Array<{ apiKeyId: string | null; normalizedCost: number }>;
    };
    const afterEntry = bodyAfter.byApiKey.find((k) => k.apiKeyId === apiKey.id);
    assert.ok(afterEntry);
    assertClose(afterEntry.normalizedCost, expectedNormalized);

    const summaryAfter = await costRules.getCostSummaryNormalized(apiKey.id);
    assertClose(summaryAfter.totalCostMonth, expectedNormalized);
    const budgetCheckAfter = await costRules.checkBudgetNormalized(apiKey.id, 0);
    assertClose(budgetCheckAfter.periodUsed, expectedNormalized);

    assertClose(spendAfter, afterEntry.normalizedCost);
    assertClose(afterEntry.normalizedCost, summaryAfter.totalCostMonth);
    assertClose(summaryAfter.totalCostMonth, budgetCheckAfter.periodUsed);

    // The mutation actually moved the number — otherwise this whole test would pass
    // vacuously even with the OLD (broken) write-time-frozen behavior.
    assert.notEqual(Math.round(spendBefore * 100), Math.round(spendAfter * 100));
  });

  test("the read surfaces (getCostSummaryNormalized / checkBudgetNormalized), not the write argument, reflect the multiplier — proves the fix reads live rather than trusting whatever was passed to recordCost", async () => {
    const apiKey = await apiKeysDb.createApiKey("Read Surface Key", "machine-fixround-02");
    costRules.setBudget(apiKey.id, {
      monthlyLimitUsd: 1000,
      resetInterval: "monthly",
      warningThreshold: 0.8,
    });

    // recordCost() is called with NO billedCost at all (as chatCore.ts does for a
    // non-redirected request that had no multiplier at the time) — domain_cost_history
    // never learns about a multiplier that gets configured afterward, by construction.
    costRules.recordCost(apiKey.id, SONNET_COST);

    // Also seed the usage_history row the NEW read-time path actually reads from.
    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKeyId: apiKey.id,
      apiKeyName: "Read Surface Key",
      connectionId: "fixround-conn-02",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    familyMultipliersDb.replaceFamilyMultipliers(apiKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: 2,
      },
    ]);

    // getCostSummaryNormalized/checkBudgetNormalized must report the MULTIPLIED figure
    // ($21) even though domain_cost_history.billed_cost (written by the recordCost()
    // call above, with no billedCost argument) still reads as NULL == real == $10.50 —
    // proving these two functions no longer consult that column at all for the
    // normalized figure.
    const summary = await costRules.getCostSummaryNormalized(apiKey.id);
    assertClose(summary.totalCostMonth, SONNET_COST * 2);

    const budgetCheck = await costRules.checkBudgetNormalized(apiKey.id, 0);
    assertClose(budgetCheck.periodUsed, SONNET_COST * 2);

    // Control: the OLD, still-present legacy basis option on getCostSummary/checkBudget
    // (kept for admin-only real-basis callers) reads the stale, write-time figure —
    // demonstrating exactly what Finding 1 was about, and that the NEW functions are a
    // real fix rather than a rename of the same behavior.
    const legacyNormalized = costRules.getCostSummary(apiKey.id, { basis: "normalized" });
    assertClose(legacyNormalized.totalCostMonth, SONNET_COST);
    assert.notEqual(
      Math.round(legacyNormalized.totalCostMonth * 100),
      Math.round(summary.totalCostMonth * 100)
    );
  });
});

describe("Finding 2 fix — every analytics bucket resolves the model-family multiplier per row, unfiltered or not", () => {
  test("an UNFILTERED response never disagrees with itself: byModel's merged total equals the sum of byApiKey's per-key (correctly multiplied) totals", async () => {
    const taxedKey = await apiKeysDb.createApiKey("Taxed Key", "machine-fixround-03a");
    const plainKey = await apiKeysDb.createApiKey("Plain Key", "machine-fixround-03b");
    familyMultipliersDb.replaceFamilyMultipliers(taxedKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: 3,
      },
    ]);

    for (const [key, name, conn] of [
      [taxedKey, "Taxed Key", "fixround-conn-03a"],
      [plainKey, "Plain Key", "fixround-conn-03b"],
    ] as const) {
      await usageHistory.saveRequestUsage({
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKeyId: key.id,
        apiKeyName: name,
        connectionId: conn,
        tokens: { input: 1_000_000, output: 500_000 },
        success: true,
        timestamp: new Date().toISOString(),
      });
    }

    // Deliberately UNFILTERED — no apiKeyIds param — the exact scenario the original
    // Finding 2 repro used ("Reviewer's repro on an unfiltered GET /api/usage/analytics").
    const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      byModel: Array<{ model: string; provider: string; normalizedCost: number; cost: number }>;
      byApiKey: Array<{ apiKeyId: string | null; normalizedCost: number; cost: number }>;
      normalizedCostCoverage: Record<string, boolean>;
    };

    const taxedEntry = body.byApiKey.find((k) => k.apiKeyId === taxedKey.id);
    const plainEntry = body.byApiKey.find((k) => k.apiKeyId === plainKey.id);
    assert.ok(taxedEntry);
    assert.ok(plainEntry);
    assertClose(taxedEntry.normalizedCost, SONNET_COST * 3);
    assertClose(plainEntry.normalizedCost, SONNET_COST);

    const modelEntry = body.byModel.find(
      (m) => m.model === "claude-sonnet-5" && m.provider === "anthropic"
    );
    assert.ok(modelEntry);
    // This is the exact assertion that would have FAILED before the fix: byModel used
    // to apply either a single scoped multiplier (or none, when unfiltered) to the
    // WHOLE merged row, instead of each contributing key's own multiplier.
    assertClose(modelEntry.normalizedCost, taxedEntry.normalizedCost + plainEntry.normalizedCost);
    assertClose(modelEntry.cost, taxedEntry.cost + plainEntry.cost);

    // Both rows had real key attribution, so coverage is complete for every bucket.
    assert.equal(body.normalizedCostCoverage.byModel, true);
    assert.equal(body.normalizedCostCoverage.byApiKey, true);
    assert.equal(body.normalizedCostCoverage.byProvider, true);
  });

  test("a row with no api-key attribution is priced neutrally for its slice AND flips the bucket's coverage flag to false, instead of silently mixing bases", async () => {
    const taxedKey = await apiKeysDb.createApiKey("Taxed Key 2", "machine-fixround-04");
    familyMultipliersDb.replaceFamilyMultipliers(taxedKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: 5,
      },
    ]);

    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKeyId: taxedKey.id,
      apiKeyName: "Taxed Key 2",
      connectionId: "fixround-conn-04a",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    // A request with NO api key attached at all (e.g. a playground/local-mode call) —
    // usage_history.api_key_id stays NULL for it, same as a row that lost attribution
    // via the daily_usage_summary rollup. Cannot be attributed to any key's multiplier.
    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKeyId: null,
      connectionId: "fixround-conn-04b",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
    const body = (await response.json()) as {
      byModel: Array<{ model: string; provider: string; normalizedCost: number; cost: number }>;
      normalizedCostCoverage: Record<string, boolean>;
    };

    const modelEntry = body.byModel.find(
      (m) => m.model === "claude-sonnet-5" && m.provider === "anthropic"
    );
    assert.ok(modelEntry);
    // taxedKey's slice: SONNET_COST * 5. The keyless slice: SONNET_COST * 1 (neutral,
    // since there is no key to resolve a multiplier against).
    assertClose(modelEntry.normalizedCost, SONNET_COST * 5 + SONNET_COST);
    assertClose(modelEntry.cost, SONNET_COST * 2);

    // The explicit signal Finding 2 asked for: this bucket mixed an attributed row with
    // an unattributed one, so its normalizedCost is honest but NOT fully multiplier-aware.
    assert.equal(body.normalizedCostCoverage.byModel, false);
  });
});
