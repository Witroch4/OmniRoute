import test from "node:test";
import assert from "node:assert/strict";

import { isMinSpendGuaranteeActive } from "../../src/lib/usage/minSpendGuarantee.ts";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function spendOf(value: number) {
  return async () => value;
}

test("guarantee is inactive when disabled", async () => {
  const active = await isMinSpendGuaranteeActive(
    { id: "key-1", minSpendGuaranteeEnabled: false, minSpendGuaranteeUsd: 50 },
    NOW,
    { getSpendSince: spendOf(0) }
  );
  assert.equal(active, false);
});

test("guarantee is inactive without a positive floor", async () => {
  for (const usd of [null, 0, -10, Number.NaN]) {
    const active = await isMinSpendGuaranteeActive(
      { id: "key-1", minSpendGuaranteeEnabled: true, minSpendGuaranteeUsd: usd as number | null },
      NOW,
      { getSpendSince: spendOf(0) }
    );
    assert.equal(active, false, `usd=${String(usd)} should be inactive`);
  }
});

test("guarantee is active while weekly spend is below the floor", async () => {
  const active = await isMinSpendGuaranteeActive(
    { id: "key-1", minSpendGuaranteeEnabled: true, minSpendGuaranteeUsd: 50 },
    NOW,
    { getSpendSince: spendOf(49.99) }
  );
  assert.equal(active, true);
});

test("guarantee turns off once weekly spend reaches the floor (respect cutoff again)", async () => {
  for (const spent of [50, 50.01, 120]) {
    const active = await isMinSpendGuaranteeActive(
      { id: "key-1", minSpendGuaranteeEnabled: true, minSpendGuaranteeUsd: 50 },
      NOW,
      { getSpendSince: spendOf(spent) }
    );
    assert.equal(active, false, `spent=${spent} should respect cutoff`);
  }
});

test("guarantee queries spend over the rolling 7d window", async () => {
  let observedSince: string | null = null;
  await isMinSpendGuaranteeActive(
    { id: "key-1", minSpendGuaranteeEnabled: true, minSpendGuaranteeUsd: 50 },
    NOW,
    {
      getSpendSince: async (_id, sinceIso) => {
        observedSince = sinceIso;
        return 0;
      },
    }
  );
  assert.equal(observedSince, new Date(NOW - WEEK_MS).toISOString());
});

test("guarantee is inactive without an api key id", async () => {
  const active = await isMinSpendGuaranteeActive(
    { id: "", minSpendGuaranteeEnabled: true, minSpendGuaranteeUsd: 50 },
    NOW,
    { getSpendSince: spendOf(0) }
  );
  assert.equal(active, false);
});

test("the guarantee measures real spend, not normalized", async () => {
  const bases: unknown[] = [];
  await isMinSpendGuaranteeActive(
    { id: "key-1", minSpendGuaranteeEnabled: true, minSpendGuaranteeUsd: 50 },
    NOW,
    {
      getSpendSince: async (_id: string, _since: string, options?: { basis?: string }) => {
        bases.push(options?.basis);
        return 10;
      },
    }
  );
  assert.deepEqual(bases, ["real"]);
});
