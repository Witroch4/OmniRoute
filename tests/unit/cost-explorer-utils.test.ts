import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCostExplorerRows,
  costsMatchAtDisplayPrecision,
  type CostExplorerAnalyticsPayload,
} from "../../src/app/(dashboard)/dashboard/costs/costExplorerUtils";

const analytics: CostExplorerAnalyticsPayload = {
  summary: {
    totalCost: 12,
    totalRequests: 12,
  },
  byProvider: [
    {
      provider: "openai",
      requests: 8,
      promptTokens: 4000,
      completionTokens: 2000,
      totalTokens: 6000,
      cost: 9,
    },
    {
      provider: "anthropic",
      requests: 4,
      promptTokens: 2000,
      completionTokens: 1000,
      totalTokens: 3000,
      cost: 3,
    },
  ],
  byModel: [
    {
      provider: "openai",
      model: "gpt-4.1",
      requests: 5,
      totalTokens: 5000,
      cost: 7,
    },
    {
      provider: "anthropic",
      model: "claude-sonnet",
      requests: 7,
      totalTokens: 7000,
      cost: 5,
    },
  ],
  byApiKey: [
    {
      apiKeyId: "key-a",
      apiKeyName: "Production",
      requests: 10,
      totalTokens: 10000,
      cost: 10,
    },
  ],
  byAccount: [
    {
      account: "team-account",
      requests: 12,
      totalTokens: 12000,
      cost: 12,
    },
  ],
  byServiceTier: [
    {
      serviceTier: "priority",
      label: "Fast",
      requests: 2,
      totalTokens: 2000,
      cost: 4,
    },
    {
      serviceTier: "standard",
      label: "Standard",
      requests: 10,
      totalTokens: 10000,
      cost: 8,
    },
  ],
};

describe("buildCostExplorerRows", () => {
  it("maps provider rows and sorts by cost descending by default", () => {
    const rows = buildCostExplorerRows({ analytics, groupBy: "provider" });

    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "openai");
    assert.equal(rows[0].cost, 9);
    assert.equal(rows[0].avgCostPerRequest, 1.125);
    assert.equal(rows[0].sharePct, 75);
  });

  it("falls back normalizedCostUsd to cost when the payload has no normalizedCost field", () => {
    const rows = buildCostExplorerRows({ analytics, groupBy: "provider" });

    // None of the fixture rows carry `normalizedCost` (no redirect happened),
    // so normalizedCostUsd must equal cost for every row.
    for (const row of rows) {
      assert.equal(row.normalizedCostUsd, row.cost);
    }
  });

  it("surfaces normalizedCostUsd separately from cost for a redirected row", () => {
    const redirectedAnalytics: CostExplorerAnalyticsPayload = {
      summary: { totalCost: 10.5, totalRequests: 1 },
      byModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet",
          requests: 1,
          totalTokens: 1500,
          cost: 10.5,
          normalizedCost: 52.5,
        },
      ],
    };

    const rows = buildCostExplorerRows({ analytics: redirectedAnalytics, groupBy: "model" });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "claude-sonnet");
    assert.equal(rows[0].cost, 10.5);
    assert.equal(rows[0].normalizedCostUsd, 52.5);
    assert.notEqual(rows[0].normalizedCostUsd, rows[0].cost);
  });

  it("filters rows case-insensitively across names and details", () => {
    const rows = buildCostExplorerRows({
      analytics,
      groupBy: "model",
      searchQuery: "ANTHROPIC",
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "claude-sonnet");
    assert.equal(rows[0].detail, "anthropic");
  });

  it("sorts numeric fields ascending when requested", () => {
    const rows = buildCostExplorerRows({
      analytics,
      groupBy: "serviceTier",
      sortKey: "requests",
      sortDirection: "asc",
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "Fast");
    assert.equal(rows[1].name, "Standard");
  });

  it("falls back to request share when cost data is absent", () => {
    const freeAnalytics: CostExplorerAnalyticsPayload = {
      summary: {
        totalCost: 0,
        totalRequests: 10,
      },
      byProvider: [
        {
          provider: "local",
          requests: 4,
          totalTokens: 4000,
          cost: 0,
        },
      ],
    };

    const rows = buildCostExplorerRows({ analytics: freeAnalytics, groupBy: "provider" });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].sharePct, 40);
  });

  it("uses normalizedCostUsd for avgCostPerRequest/sharePct when costBasis is billed", () => {
    const redirectedAnalytics: CostExplorerAnalyticsPayload = {
      summary: { totalCost: 10.5, totalRequests: 2 },
      byModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet",
          requests: 1,
          totalTokens: 1500,
          cost: 10.5, // real: priced at sonnet (served) rates
          normalizedCost: 52.5, // billed: priced at opus (requested) rates
        },
        {
          provider: "anthropic",
          model: "claude-haiku",
          requests: 1,
          totalTokens: 500,
          cost: 1,
          // no normalizedCost field: never redirected, real === billed
        },
      ],
    };

    const realRows = buildCostExplorerRows({
      analytics: redirectedAnalytics,
      groupBy: "model",
      costBasis: "real",
    });
    const sonnetReal = realRows.find((row) => row.name === "claude-sonnet");
    assert.equal(sonnetReal.avgCostPerRequest, 10.5);
    // Real basis: share is cost/summary.totalCost = 10.5/10.5 = 100%.
    assert.equal(sonnetReal.sharePct, 100);

    const billedRows = buildCostExplorerRows({
      analytics: redirectedAnalytics,
      groupBy: "model",
      costBasis: "billed",
    });
    const sonnetBilled = billedRows.find((row) => row.name === "claude-sonnet");
    const haikuBilled = billedRows.find((row) => row.name === "claude-haiku");
    // Billed basis: avgCostPerRequest follows normalizedCostUsd, not cost.
    assert.equal(sonnetBilled.avgCostPerRequest, 52.5);
    // Billed basis: share is normalizedCostUsd / sum(normalizedCostUsd across the
    // dimension) = 52.5 / (52.5 + 1) = ~98.13%, not summary.totalCost (10.5), which
    // would silently mis-attribute nearly all share to the wrong total.
    assert.ok(Math.abs(sonnetBilled.sharePct - (52.5 / 53.5) * 100) < 1e-9);
    assert.ok(Math.abs(haikuBilled.sharePct - (1 / 53.5) * 100) < 1e-9);
    // The raw `cost`/`normalizedCostUsd` fields never change with costBasis — only
    // which one downstream (avg/share) treats as primary changes.
    assert.equal(sonnetBilled.cost, 10.5);
    assert.equal(sonnetBilled.normalizedCostUsd, 52.5);
  });

  it("keeps share percentages cost-based when paid and free rows are mixed", () => {
    const mixedAnalytics: CostExplorerAnalyticsPayload = {
      summary: {
        totalCost: 100,
        totalRequests: 200,
      },
      byProvider: [
        {
          provider: "paid-a",
          requests: 100,
          totalTokens: 10000,
          cost: 60,
        },
        {
          provider: "paid-b",
          requests: 80,
          totalTokens: 8000,
          cost: 40,
        },
        {
          provider: "free",
          requests: 20,
          totalTokens: 2000,
          cost: 0,
        },
      ],
    };

    const rows = buildCostExplorerRows({ analytics: mixedAnalytics, groupBy: "provider" });

    assert.deepEqual(
      rows.map((row) => row.sharePct),
      [60, 40, 0]
    );
    assert.equal(
      rows.reduce((sum, row) => sum + row.sharePct, 0),
      100
    );
  });

  it("marks costsMatchDisplay=true for an unredirected row and false for a genuinely redirected one", () => {
    const rows = buildCostExplorerRows({ analytics, groupBy: "provider" });
    // None of the fixture rows carry `normalizedCost` — real === billed for all of them.
    assert.ok(rows.every((row) => row.costsMatchDisplay === true));

    const redirectedAnalytics: CostExplorerAnalyticsPayload = {
      summary: { totalCost: 10.5, totalRequests: 1 },
      byModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet",
          requests: 1,
          totalTokens: 1500,
          cost: 10.5,
          normalizedCost: 52.5,
        },
      ],
    };
    const redirectedRows = buildCostExplorerRows({
      analytics: redirectedAnalytics,
      groupBy: "model",
    });
    assert.equal(redirectedRows[0].costsMatchDisplay, false);
  });
});

describe("costsMatchAtDisplayPrecision", () => {
  it("treats exactly equal values as matching", () => {
    assert.equal(costsMatchAtDisplayPrecision(0.0105, 0.0105), true);
    assert.equal(costsMatchAtDisplayPrecision(0, 0), true);
  });

  it("treats a genuine, visible difference as not matching", () => {
    // Both >= 0.01 and < 1, so 4 displayed fraction digits — 0.0525 vs 0.0105
    // renders as "$0.0525" vs "$0.0105", a real difference a reader would see.
    assert.equal(costsMatchAtDisplayPrecision(0.0105, 0.0525), false);
  });

  it("treats a sub-cent floating-point gap below the displayed precision as matching (the rounding edge)", () => {
    // Two numbers meant to be the identical $0.0105, but arrived at via separate
    // pricing-resolution passes with different floating-point rounding noise —
    // the exact scenario the suppression exists to survive. At 0.0105's 4
    // displayed fraction digits, both round to 0.0105.
    assert.equal(costsMatchAtDisplayPrecision(0.0105000000000001, 0.0104999999999999), true);
  });

  it("REVISED in round 2 — a value straddling the $0.01 tier boundary is NOT treated as matching, even though it's numerically near-identical", () => {
    // Round 1 rounded both values from cost's fraction-digit count alone, which
    // made this pair compare equal (0.0100000001 has 4 displayed digits on its
    // own tier, 0.0099999999 has 6 — anchoring on cost's 4 digits rounded both
    // to 0.0100). That was itself an instance of the anchor-on-one-argument bug
    // fix round 2 addresses generally: the renderer actually shows these as
    // "$0.0100" (cost's own 4-digit tier) vs "$0.010000" (normalizedCostUsd's
    // own 6-digit tier) — genuinely different strings, padding aside — so the
    // string-comparison fix correctly does NOT suppress here. Showing two
    // numbers that are this close is an acceptable trade-off; the alternative
    // (round 1's behavior) is exactly the class of false positive round 2 fixes.
    assert.equal(costsMatchAtDisplayPrecision(0.0100000001, 0.0099999999), false);
  });

  it("still finds a real difference when it lands exactly on a fraction-digit boundary", () => {
    // 0.01 sits exactly on the 0.01 threshold (4 displayed digits, since the
    // check is strictly-less-than) vs 0.02 — a full cent apart, unambiguously a
    // different number at the precision shown.
    assert.equal(costsMatchAtDisplayPrecision(0.01, 0.02), false);
  });

  it("scales fraction digits with magnitude — a sub-cent gap matters below the $0.01 threshold", () => {
    // Below $0.01, the display uses 6 fraction digits, so a gap this size (5e-6)
    // is visible at that precision and must NOT be suppressed.
    assert.equal(costsMatchAtDisplayPrecision(0.000001, 0.000006), false);
  });

  // --- Round 2 regression coverage: the reviewer's exact false-positive case ---
  //
  // Round 1 derived fraction digits from `cost` alone. `cost=1.00` sits at the
  // coarse >=1 tier (2 digits: "$1.00"); `normalizedCostUsd=0.995` sits at the
  // finer <1 tier on its OWN magnitude (4 digits: "$0.9950") — a visibly
  // different string. Anchoring on `cost` rounded 0.995 to 2 digits too (1.00),
  // making the two compare equal and suppressing a genuinely different pair.
  // The bug was asymmetric — swapping the arguments happened to give the
  // correct answer, purely because the anchor (now the second value) landed in
  // the coarser tier in that direction. A fix must be correct in BOTH
  // directions, which is exactly what pure string-equality guarantees for free
  // (string equality is inherently symmetric — there is no "anchor" anymore).

  it("no false positive at the $1.00 tier boundary — cost coarser, normalizedCostUsd finer (the reviewer's exact case)", () => {
    assert.equal(costsMatchAtDisplayPrecision(1.0, 0.995), false);
  });

  it("no false positive at the $1.00 tier boundary — arguments reversed (this direction was already correct in round 1; must stay correct)", () => {
    assert.equal(costsMatchAtDisplayPrecision(0.995, 1.0), false);
  });

  it("the $1.00 boundary check is symmetric", () => {
    assert.equal(
      costsMatchAtDisplayPrecision(1.0, 0.995),
      costsMatchAtDisplayPrecision(0.995, 1.0)
    );
  });

  it("no false positive at the $0.01 tier boundary in either argument order", () => {
    // cost=0.01 sits at the >=0.01 tier (4 digits: "$0.0100"); 0.0099 sits just
    // below it, at its OWN <0.01 tier (6 digits: "$0.009900") — different
    // strings, so neither argument order may report a match.
    assert.equal(costsMatchAtDisplayPrecision(0.01, 0.0099), false);
    assert.equal(costsMatchAtDisplayPrecision(0.0099, 0.01), false);
  });
});
