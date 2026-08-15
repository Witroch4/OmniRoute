import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildCostExplorerRows } from "../../src/app/(dashboard)/dashboard/costs/costExplorerUtils.ts";

/**
 * The Cost Explorer prices every row twice (Cost / Normalized cost) but counted
 * volume only once, under whichever identity `costBasis` selected. A row served by
 * `claude-sonnet-5` because a budget rule redirected `claude-opus-5` therefore read
 * "721 requests" in Real and "286 requests" in Billed, and the operator had to flip
 * the toggle and diff two screens to see that a redirect had happened at all.
 *
 * Numbers below are the real production shape for API key `rey cc`: 775 opus served
 * directly, 435 opus redirected to sonnet, 286 sonnet asked for directly.
 */
describe("cost explorer — served vs requested volume on one row", () => {
  const analytics = {
    summary: { totalCost: 388.58, totalRequests: 1497 },
    byModel: [
      {
        provider: "claude",
        model: "claude-opus-5",
        rawModel: "claude-opus-5",
        requests: 775,
        totalTokens: 133_844_650,
        cost: 245.68,
        normalizedCost: 245.68,
        servedRequests: 775,
        requestedRequests: 1210,
        servedTotalTokens: 133_844_650,
        requestedTotalTokens: 296_387_712,
      },
      {
        provider: "claude",
        model: "claude-sonnet-5",
        rawModel: "claude-sonnet-5",
        requests: 721,
        totalTokens: 201_691_647,
        cost: 142.85,
        normalizedCost: 340.69,
        servedRequests: 721,
        requestedRequests: 286,
        servedTotalTokens: 201_691_647,
        requestedTotalTokens: 39_148_585,
      },
    ],
  };

  function rowsFor(costBasis: "real" | "billed") {
    return buildCostExplorerRows({ analytics, groupBy: "model", costBasis });
  }

  test("carries both sides so a redirect is readable without flipping the toggle", () => {
    const rows = rowsFor("real");
    const opus = rows.find((r) => r.name.includes("opus"));
    const sonnet = rows.find((r) => r.name.includes("sonnet"));

    assert.equal(opus?.servedRequests, 775);
    assert.equal(opus?.requestedRequests, 1210);
    assert.equal(sonnet?.servedRequests, 721);
    assert.equal(sonnet?.requestedRequests, 286);
  });

  test("flags the split only when a redirect actually moved traffic", () => {
    const rows = rowsFor("real");
    assert.equal(
      rows.every((r) => r.volumeSplitDiffers),
      true,
      "both rows in this fixture were touched by the opus -> sonnet rule"
    );

    const untouched = buildCostExplorerRows({
      analytics: {
        summary: { totalCost: 1, totalRequests: 10 },
        byModel: [
          {
            provider: "claude",
            model: "claude-haiku-4-5",
            rawModel: "claude-haiku-4-5",
            requests: 10,
            totalTokens: 43_404,
            cost: 1,
            normalizedCost: 1,
            servedRequests: 10,
            requestedRequests: 10,
            servedTotalTokens: 43_404,
            requestedTotalTokens: 43_404,
          },
        ],
      },
      groupBy: "model",
      costBasis: "real",
    });
    assert.equal(untouched[0]?.volumeSplitDiffers, false, "renders as — instead of a repeat");
  });

  test("the split is basis-independent — same numbers under Real and Billed", () => {
    const real = rowsFor("real").find((r) => r.name.includes("sonnet"));
    const billed = rowsFor("billed").find((r) => r.name.includes("sonnet"));

    // `requests` follows the basis (that is pre-existing behaviour and stays),
    // but the two explicit sides must not move when the toggle does.
    assert.equal(real?.servedRequests, billed?.servedRequests);
    assert.equal(real?.requestedRequests, billed?.requestedRequests);
    assert.equal(real?.servedTotalTokens, billed?.servedTotalTokens);
    assert.equal(real?.requestedTotalTokens, billed?.requestedTotalTokens);
  });

  test("an older cached payload without the fields collapses instead of inventing a split", () => {
    const rows = buildCostExplorerRows({
      analytics: {
        summary: { totalCost: 10, totalRequests: 100 },
        byModel: [
          {
            provider: "claude",
            model: "claude-opus-5",
            rawModel: "claude-opus-5",
            requests: 100,
            totalTokens: 5000,
            cost: 10,
          },
        ],
      },
      groupBy: "model",
      costBasis: "real",
    });

    assert.equal(rows[0]?.servedRequests, 100);
    assert.equal(rows[0]?.requestedRequests, 100);
    assert.equal(rows[0]?.volumeSplitDiffers, false);
  });

  test("new sort keys resolve against the row fields", () => {
    const desc = buildCostExplorerRows({
      analytics,
      groupBy: "model",
      costBasis: "real",
      sortKey: "requestedRequests",
      sortDirection: "desc",
    });
    assert.equal(desc[0]?.requestedRequests, 1210, "opus asked for most often sorts first");

    const asc = buildCostExplorerRows({
      analytics,
      groupBy: "model",
      costBasis: "real",
      sortKey: "requestedRequests",
      sortDirection: "asc",
    });
    assert.equal(asc[0]?.requestedRequests, 286);
  });
});
