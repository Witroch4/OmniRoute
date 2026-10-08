/**
 * Long-context pricing, end to end against a real SQLite: the cost call sites that SUM
 * tokens must bill each request on its own prompt size, never on the sum.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-long-context-wiring-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "long-context-wiring-secret";

const core = await import("../../src/lib/db/core.ts");
const analytics = await import("../../src/lib/db/usageAnalytics.ts");
const limits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const stats = await import("../../src/lib/usage/usageStats.ts");
const { computeCostFromPricing } = await import("../../src/lib/usage/costCalculator.ts");
const { readLongContextColumns } = await import("../../src/lib/usage/longContextSql.ts");
const { getDefaultPricing } = await import("../../src/shared/constants/pricing.ts");

const HAIKU = getDefaultPricing().cc["claude-haiku-5-5"] as Record<string, unknown>;
const KEY = "key-long-context";
const SINCE = "2026-06-01T00:00:00.000Z";

type Req = { input: number; output: number; cacheRead?: number; at?: string };

function insert(provider: string, model: string, r: Req) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO usage_history (
        timestamp, provider, model, tokens_input, tokens_output, tokens_cache_read,
        tokens_cache_creation, tokens_reasoning, service_tier, success, latency_ms,
        connection_id, api_key_id, api_key_name
      ) VALUES (@at, @provider, @model, @input, @output, @cacheRead, 0, 0, 'standard', 1, 10,
        'conn-1', @key, 'k')`
    )
    .run({
      at: r.at ?? "2026-06-10T12:00:00.000Z",
      provider,
      model,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead ?? 0,
      key: KEY,
    });
}

/** What the bill is: every request priced on its own prompt size. */
function perRequestCost(requests: Req[]): number {
  return requests.reduce(
    (sum, r) =>
      sum +
      computeCostFromPricing(
        HAIKU,
        { input: r.input, output: r.output, cacheRead: r.cacheRead ?? 0 },
        { requestScoped: true }
      ),
    0
  );
}

const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);

test.beforeEach(() => {
  const db = core.getDbInstance();
  db.exec("DELETE FROM usage_history; DELETE FROM daily_usage_summary;");
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const SMALL: Req = { input: 2_000, output: 100 };
const LONG: Req = { input: 150_000, output: 2_000, cacheRead: 100_000 };

test("API key spend: 200 small requests whose SUM crosses 100K stay at base rates", async () => {
  const requests = Array.from({ length: 200 }, () => SMALL);
  for (const r of requests) insert("claude", "claude-haiku-5-5", r);

  const spend = await limits.getApiKeyUsdSpendSince(KEY, SINCE);
  near(spend, perRequestCost(requests), "grouped spend equals per-request pricing");
  // The naive tiering would be 5x this — the regression this guards.
  near(spend, 200 * (2_000 * 0.1e-6 + 100 * 0.5e-6), "base rates");
});

test("API key spend: long requests are billed at the tier, small ones are not", async () => {
  const requests = [...Array.from({ length: 50 }, () => SMALL), LONG, LONG];
  for (const r of requests) insert("claude", "claude-haiku-5-5", r);

  const spend = await limits.getApiKeyUsdSpendSince(KEY, SINCE);
  near(spend, perRequestCost(requests), "mixed bucket");
  const longPart = 2 * (50_000 * 0.5e-6 + 100_000 * 0.05e-6 + 2_000 * 2.5e-6);
  const smallPart = 50 * (2_000 * 0.1e-6 + 100 * 0.5e-6);
  near(spend, longPart + smallPart, "explicit arithmetic");

  const real = await limits.getApiKeyFamilyRealSpendSince(KEY, "claude", "claude-haiku-*", SINCE);
  near(real, spend, "budget-routing spend agrees with the key quota spend");
});

test("a model without a long_context block ignores the bucket entirely", async () => {
  const requests = [SMALL, { input: 400_000, output: 3_000 }];
  for (const r of requests) insert("claude", "claude-haiku-4-5-20251001", r);
  const spend = await limits.getApiKeyUsdSpendSince(KEY, SINCE);
  near(spend, 402_000 * 1e-6 + 3_100 * 5e-6, "Haiku 4.5 stays flat");
});

test("usage stats price the recent window per request, not on the sum", async () => {
  const now = new Date().toISOString();
  const requests = [
    ...Array.from({ length: 120 }, () => ({ ...SMALL, at: now })),
    { ...LONG, at: now },
  ];
  for (const r of requests) insert("claude", "claude-haiku-5-5", r);

  const result = await stats.getUsageStats();
  near(result.totalCost, perRequestCost(requests), "stats total");
});

test("unified analytics source: day totals from daily_usage_summary are never 'long'", () => {
  const db = core.getDbInstance();
  // A rolled-up day: 5M prompt tokens across thousands of small requests.
  db.prepare(
    `INSERT INTO daily_usage_summary (date, provider, model, total_input_tokens,
       total_output_tokens, total_requests, total_cost)
     VALUES ('2026-05-20', 'claude', 'claude-haiku-5-5', 5000000, 200000, 2500, 0)`
  ).run();
  insert("claude", "claude-haiku-5-5", { ...SMALL, at: "2026-06-12T12:00:00.000Z" });
  insert("claude", "claude-haiku-5-5", { ...LONG, at: "2026-06-12T13:00:00.000Z" });

  const { unifiedSource, unifiedParams } = analytics.buildUnifiedSource({
    sinceIso: null,
    untilIso: null,
    rawCutoffDate: "2026-06-01",
    apiKeyWhere: "",
    apiKeyParams: {},
  });
  assert.ok(unifiedSource.includes("daily_usage_summary"), "summary branch is in play");

  const rows = (
    analytics.getModelUsageRows(unifiedSource, unifiedParams) as unknown as Array<
      Record<string, number | string>
    >
  ).filter((r) => r.model === "claude-haiku-5-5");
  // The summary row groups apart (no api key) from the raw rows; price each row the way
  // the analytics route does and add them up.
  assert.ok(rows.length >= 2, "summary and raw rows are both present");
  const prompt = rows.reduce((sum, r) => sum + Number(r.promptTokens), 0);
  const lcPrompt = rows.reduce((sum, r) => sum + Number(r.lcPromptTokens), 0);
  assert.equal(prompt, 5_000_000 + 2_000 + 150_000, "summary tokens are counted");
  assert.equal(lcPrompt, 150_000, "only the one real long request is in the long bucket");

  const cost = rows.reduce(
    (sum, r) =>
      sum +
      computeCostFromPricing(
        HAIKU,
        {
          input: Number(r.promptTokens),
          output: Number(r.completionTokens),
          cacheRead: Number(r.cacheReadTokens),
          cacheCreation: Number(r.cacheCreationTokens),
          reasoning: Number(r.reasoningTokens),
          ...readLongContextColumns(r),
        },
        {}
      ),
    0
  );
  near(
    cost,
    perRequestCost([SMALL, LONG]) + 5_000_000 * 0.1e-6 + 200_000 * 0.5e-6,
    "summary days bill at base, raw requests per request"
  );
});

test("account/api-key/preset/tier analytics queries expose the same long-context split", () => {
  insert("claude", "claude-haiku-5-5", SMALL);
  insert("claude", "claude-haiku-5-5", LONG);
  const { unifiedSource, unifiedParams } = analytics.buildUnifiedSource({
    sinceIso: SINCE,
    untilIso: null,
    rawCutoffDate: "2026-01-01",
    apiKeyWhere: "",
    apiKeyParams: {},
  });
  const { unifiedSource: presetSource, unifiedParams: presetParams } =
    analytics.buildPresetUnifiedSource({
      sinceIso: SINCE,
      untilIso: null,
      rawCutoffDate: "2026-01-01",
      apiKeyWhere: "",
      apiKeyParams: {},
    });

  const sets: Array<[string, Array<Record<string, number>>]> = [
    ["dailyCost", analytics.getDailyCostRows(unifiedSource, unifiedParams) as never],
    ["providerCost", analytics.getProviderCostRows(unifiedSource, unifiedParams) as never],
    ["serviceTier", analytics.getServiceTierUsageRows(unifiedSource, unifiedParams) as never],
    ["preset", analytics.getPresetCostModelRows(presetSource, presetParams) as never],
  ];
  for (const [name, rows] of sets) {
    const long = rows.reduce((sum, r) => sum + (r.lcPromptTokens ?? 0), 0);
    assert.equal(long, 150_000, `${name}: lcPromptTokens`);
  }
});
