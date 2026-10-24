import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS,
  LONG_CONTEXT_SQL_THRESHOLDS,
  computeCostFromPricing,
  isLongContextPrompt,
  longContextTierKey,
} from "../../src/lib/usage/costCalculator.ts";
import {
  longContextSumColumns,
  readLongContextColumns,
} from "../../src/lib/usage/longContextSql.ts";
import { resolveModelPricing } from "../../src/lib/usage/pricingResolution.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";
import { updatePricingSchema } from "../../src/shared/validation/schemas/pricing.ts";

const T = LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS;

// Haiku 5.5 list prices: base $0.10/$0.50 (cache read 0.01, write 0.125),
// over-100K prompts $0.50/$2.50 (cache read 0.05, write 0.625).
const TIERED = {
  input: 0.1,
  output: 0.5,
  cached: 0.01,
  reasoning: 0.5,
  cache_creation: 0.125,
  long_context: { input: 0.5, output: 2.5, cached: 0.05, reasoning: 2.5, cache_creation: 0.625 },
};
const FLAT = { input: 0.1, output: 0.5, cached: 0.01, reasoning: 0.5, cache_creation: 0.125 };

const near = (actual: number, expected: number, label = "") =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} expected ${expected}, got ${actual}`);

test("the threshold is the published 100,000 tokens", () => {
  assert.equal(T, 100_000);
});

test("a request exactly at the threshold bills at base rates; one token over bills the tier", () => {
  const at = { input: T, output: 1_000_000 };
  const over = { input: T + 1, output: 1_000_000 };
  assert.equal(isLongContextPrompt(at), false);
  assert.equal(isLongContextPrompt(over), true);

  near(computeCostFromPricing(TIERED, at, { requestScoped: true }), T * 0.1e-6 + 0.5, "at");
  near(
    computeCostFromPricing(TIERED, over, { requestScoped: true }),
    (T + 1) * 0.5e-6 + 2.5,
    "over"
  );
});

test("the whole long request is repriced — input, output, cache read and cache write", () => {
  const request = {
    input: 150_000, // includes the cache fields below
    cacheRead: 100_000,
    cacheCreation: 20_000,
    output: 4_000,
    reasoning: 1_000,
  };
  const expected =
    30_000 * 0.5e-6 + // non-cached input
    100_000 * 0.05e-6 + // cache read
    20_000 * 0.625e-6 + // cache write
    4_000 * 2.5e-6; // output — reasoning (1K) is inside it and the tier has no premium (#15496)
  near(computeCostFromPricing(TIERED, request, { requestScoped: true }), expected);
});

test("SUMS are never tiered: many small requests that add up past the threshold stay at base", () => {
  // 200 requests of 2K prompt / 100 output — the hazard this design exists to prevent.
  const sums = { input: 200 * 2_000, output: 200 * 100 };
  assert.ok(sums.input > T, "the sum alone crosses the threshold");

  const withTier = computeCostFromPricing(TIERED, sums);
  const flat = computeCostFromPricing(FLAT, sums);
  near(withTier, flat, "grouped tokens without a split must price at base");
  near(withTier, 400_000 * 0.1e-6 + 20_000 * 0.5e-6);
});

test("grouped tokens price the long part at the tier and the rest at base", () => {
  // Bucket: 3 small requests (10K prompt, 1K out each) + 2 long (150K, 2K out each).
  const tokens = {
    input: 3 * 10_000 + 2 * 150_000,
    output: 3 * 1_000 + 2 * 2_000,
    lcInput: 2 * 150_000,
    lcOutput: 2 * 2_000,
  };
  const perRequest =
    3 * computeCostFromPricing(TIERED, { input: 10_000, output: 1_000 }, { requestScoped: true }) +
    2 * computeCostFromPricing(TIERED, { input: 150_000, output: 2_000 }, { requestScoped: true });
  near(computeCostFromPricing(TIERED, tokens), perRequest, "grouped == sum of per-request");
});

test("grouped long part with cache subtracts cache inside the long part only", () => {
  const tokens = {
    input: 50_000 + 200_000,
    cacheRead: 10_000 + 150_000,
    output: 500 + 3_000,
    lcInput: 200_000,
    lcCacheRead: 150_000,
    lcOutput: 3_000,
  };
  const perRequest =
    computeCostFromPricing(
      TIERED,
      { input: 50_000, cacheRead: 10_000, output: 500 },
      { requestScoped: true }
    ) +
    computeCostFromPricing(
      TIERED,
      { input: 200_000, cacheRead: 150_000, output: 3_000 },
      { requestScoped: true }
    );
  near(computeCostFromPricing(TIERED, tokens), perRequest);
});

test("a long part larger than the total is clamped — never bills tokens that were not counted", () => {
  const tokens = { input: 1_000, output: 100, lcInput: 9_000_000, lcOutput: 9_000_000 };
  near(
    computeCostFromPricing(TIERED, tokens),
    1_000 * 0.5e-6 + 100 * 2.5e-6,
    "clamped to the total, billed as long"
  );
});

test("models without a long_context block ignore the split and the scope flag", () => {
  const tokens = { input: 500_000, output: 2_000, lcInput: 500_000, lcOutput: 2_000 };
  const expected = 500_000 * 0.1e-6 + 2_000 * 0.5e-6;
  near(computeCostFromPricing(FLAT, tokens), expected);
  near(computeCostFromPricing(FLAT, tokens, { requestScoped: true }), expected);
});

test("a malformed long_context block is ignored, not guessed at", () => {
  const tokens = { input: 500_000, output: 2_000 };
  const base = computeCostFromPricing(FLAT, tokens);
  for (const bad of [null, "x", [], {}, { input: 0.5 }, { input: -1, output: 2 }]) {
    near(
      computeCostFromPricing({ ...FLAT, long_context: bad }, tokens, { requestScoped: true }),
      base,
      JSON.stringify(bad)
    );
  }
});

test("a tier that omits optional rates falls back to its own input/output rates", () => {
  const sparse = { ...FLAT, long_context: { input: 0.5, output: 2.5 } };
  // reasoning falls back to the tier output rate, cache read to the tier input rate.
  near(
    computeCostFromPricing(
      sparse,
      { input: 200_000, cacheRead: 100_000, reasoning: 1_000 },
      { requestScoped: true }
    ),
    100_000 * 0.5e-6 + 100_000 * 0.5e-6 + 1_000 * 2.5e-6
  );
});

test("Haiku 5.5 carries the tier in both catalogs and resolves it exactly", () => {
  for (const provider of ["claude", "anthropic"]) {
    const resolution = resolveModelPricing(getDefaultPricing(), provider, "claude-haiku-5-5");
    assert.equal(resolution.source, "exact", provider);
    assert.deepEqual(
      (resolution.pricing as { long_context?: Record<string, number> }).long_context,
      { input: 0.5, output: 2.5, cached: 0.05, reasoning: 2.5, cache_creation: 0.625 },
      provider
    );
  }
});

test("every default long_context tier can be split per request by the grouped SQL", () => {
  // Grouped cost paths (key spend, analytics) only bill a tier whose threshold has a
  // per-request SQL bucket; any other threshold would silently fall back to base rates.
  const bucketed = new Set(LONG_CONTEXT_SQL_THRESHOLDS.map(longContextTierKey));
  const withTier: string[] = [];
  for (const [provider, models] of Object.entries(getDefaultPricing())) {
    for (const [model, row] of Object.entries(models as Record<string, Record<string, unknown>>)) {
      const tier = row.long_context as Record<string, unknown> | undefined;
      if (!tier) continue;
      withTier.push(`${provider}/${model}`);
      const key =
        typeof tier.threshold === "number"
          ? longContextTierKey({ threshold: tier.threshold, inclusive: tier.inclusive === true })
          : longContextTierKey(LONG_CONTEXT_SQL_THRESHOLDS[0]);
      assert.ok(bucketed.has(key), `${provider}/${model}: threshold ${key} has no SQL bucket`);
    }
  }
  // Haiku 5.5 keeps the fork's rates-only block (published 100K threshold).
  for (const id of ["anthropic/claude-haiku-5-5", "cc/claude-haiku-5-5"]) {
    assert.ok(withTier.includes(id), id);
  }
});

test("a grouped bucket uses the split for the row's own threshold, never the default one", () => {
  const openAiLike = {
    input: 2.5,
    output: 15,
    long_context: { threshold: 272_000, input: 5, output: 22.5 },
  };
  // Two requests: 150K (over 100K, under 272K) and 300K (over both).
  const tokens = {
    input: 450_000,
    output: 2_000,
    lcInput: 450_000, // default (100K) bucket: both requests
    lcOutput: 2_000,
    lcTiers: { "272000": { lcInput: 300_000, lcOutput: 1_000 } },
  };
  const perRequest =
    computeCostFromPricing(openAiLike, { input: 150_000, output: 1_000 }, { requestScoped: true }) +
    computeCostFromPricing(openAiLike, { input: 300_000, output: 1_000 }, { requestScoped: true });
  near(computeCostFromPricing(openAiLike, tokens), perRequest, "272K split");
  // Without the matching split the bucket bills at base — never at a tier decided on sums.
  near(
    computeCostFromPricing(openAiLike, { input: 450_000, output: 2_000, lcInput: 450_000 }),
    450_000 * 2.5e-6 + 2_000 * 15e-6,
    "no 272K split"
  );
});

test("the pricing editor can post a row that carries the tier back", () => {
  const ok = updatePricingSchema.safeParse({ cc: { "claude-haiku-5-5": TIERED } });
  assert.equal(ok.success, true);
  const unknownKey = updatePricingSchema.safeParse({
    cc: { "claude-haiku-5-5": { ...FLAT, long_context: { ...TIERED.long_context, bogus: 1 } } },
  });
  assert.equal(unknownKey.success, false);
});

test("SQL buckets split per request exactly like the per-request pricing", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE usage_history (
    model TEXT, tokens_input INTEGER, tokens_output INTEGER,
    tokens_cache_read INTEGER, tokens_cache_creation INTEGER, tokens_reasoning INTEGER)`);
  const insert = db.prepare("INSERT INTO usage_history VALUES (?,?,?,?,?,?)");
  const requests = [
    { input: 10_000, output: 500, cacheRead: 2_000, cacheCreation: 0, reasoning: 0 },
    { input: T, output: 700, cacheRead: 0, cacheCreation: 100, reasoning: 5 }, // exactly at: base
    { input: T + 1, output: 900, cacheRead: 60_000, cacheCreation: 1_000, reasoning: 10 },
    { input: 400_000, output: 3_000, cacheRead: 350_000, cacheCreation: 0, reasoning: 0 },
  ];
  for (const r of requests) {
    insert.run("m", r.input, r.output, r.cacheRead, r.cacheCreation, r.reasoning);
  }
  insert.run("m", null, 50, null, null, null); // NULL prompt counts as not long

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
         ${longContextSumColumns()}
       FROM usage_history GROUP BY model`
    )
    .get() as Record<string, number>;

  const grouped = computeCostFromPricing(
    TIERED,
    {
      input: row.promptTokens,
      output: row.completionTokens,
      cacheRead: row.cacheReadTokens,
      cacheCreation: row.cacheCreationTokens,
      reasoning: row.reasoningTokens,
      ...readLongContextColumns(row),
    },
    {}
  );
  const perRequest =
    requests.reduce(
      (sum, r) => sum + computeCostFromPricing(TIERED, r, { requestScoped: true }),
      0
    ) + computeCostFromPricing(TIERED, { output: 50 }, { requestScoped: true });
  near(grouped, perRequest, "SQL buckets reproduce per-request pricing");
  assert.equal(row.lcPromptTokens, T + 1 + 400_000);
});

test("SQL buckets for an explicit threshold (OpenAI >272K, xAI >=200K) match per-request pricing", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE usage_history (
    model TEXT, tokens_input INTEGER, tokens_output INTEGER,
    tokens_cache_read INTEGER, tokens_cache_creation INTEGER, tokens_reasoning INTEGER)`);
  const insert = db.prepare("INSERT INTO usage_history VALUES (?,?,?,?,?,?)");
  const requests = [
    { input: 50_000, output: 500, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    { input: 150_000, output: 700, cacheRead: 100_000, cacheCreation: 0, reasoning: 0 },
    { input: 200_000, output: 800, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    { input: 272_000, output: 900, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    { input: 300_000, output: 1_000, cacheRead: 200_000, cacheCreation: 0, reasoning: 0 },
  ];
  for (const r of requests) {
    insert.run("m", r.input, r.output, r.cacheRead, r.cacheCreation, r.reasoning);
  }
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
         ${longContextSumColumns()}
       FROM usage_history GROUP BY model`
    )
    .get() as Record<string, number>;
  const grouped = {
    input: row.promptTokens,
    output: row.completionTokens,
    cacheRead: row.cacheReadTokens,
    cacheCreation: row.cacheCreationTokens,
    reasoning: row.reasoningTokens,
    ...readLongContextColumns(row),
  };
  const rows = [
    {
      input: 2.5,
      output: 15,
      cached: 0.25,
      long_context: { threshold: 272_000, input: 5, output: 22.5, cached: 0.5 },
    },
    {
      input: 2,
      output: 6,
      cached: 0.5,
      long_context: { threshold: 200_000, inclusive: true, input: 4, output: 12, cached: 1 },
    },
  ];
  for (const pricing of rows) {
    const perRequest = requests.reduce(
      (sum, r) => sum + computeCostFromPricing(pricing, r, { requestScoped: true }),
      0
    );
    near(
      computeCostFromPricing(pricing, grouped),
      perRequest,
      JSON.stringify(pricing.long_context)
    );
  }
});
