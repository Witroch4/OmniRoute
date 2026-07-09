import test from "node:test";
import assert from "node:assert/strict";

const { extractReportedCostUsd, resolveCostUsd } =
  await import("../../src/lib/usage/reportedCost.ts");

test("extractReportedCostUsd reads explicit top-level USD cost fields", () => {
  assert.equal(extractReportedCostUsd({ cost: 0.0256518 }), 0.0256518);
  assert.equal(extractReportedCostUsd({ cost_usd: "0.0123" }), 0.0123);
  assert.equal(extractReportedCostUsd({ costUsd: 0.0042 }), 0.0042);
});

test("extractReportedCostUsd ignores invalid, negative, and nested generic cost fields", () => {
  assert.equal(extractReportedCostUsd({ cost: -1, cost_usd: "nope" }), null);
  assert.equal(extractReportedCostUsd({ usage: { cost: 0.5 } }), null);
  assert.equal(extractReportedCostUsd({ usage: { cost_usd: 0.5 } }), 0.5);
});

test("resolveCostUsd prefers reported response cost over internal estimate", async () => {
  let calculateCalled = false;
  const cost = await resolveCostUsd({
    reportedCostSources: [{ cost: 0.0256518 }],
    provider: "claude",
    model: "claude-sonnet-4-6",
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    calculateCost: async () => {
      calculateCalled = true;
      return 99;
    },
  });

  assert.equal(cost, 0.0256518);
  assert.equal(calculateCalled, false);
});

test("resolveCostUsd falls back to internal estimate when no valid reported cost exists", async () => {
  const cost = await resolveCostUsd({
    reportedCostSources: [{ cost: -1 }, { usage: { cost: 0.5 } }],
    provider: "openai",
    model: "gpt-x",
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    calculateCost: async (provider, model, usage) => {
      assert.equal(provider, "openai");
      assert.equal(model, "gpt-x");
      assert.deepEqual(usage, { prompt_tokens: 100, completion_tokens: 10 });
      return 0.1234;
    },
  });

  assert.equal(cost, 0.1234);
});
