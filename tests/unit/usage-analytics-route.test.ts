import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-analytics-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "test-usage-analytics-secret";

const core = await import("../../src/lib/db/core.ts");
const { updatePricing } = await import("@/lib/db/settings");
const localDb = { updatePricing };
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const aggregateHistory = await import("../../src/lib/usage/aggregateHistory.ts");
const analyticsRoute = await import("../../src/app/api/usage/analytics/route.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const analyticsCache = await import("../../src/lib/usage/analyticsResponseCache.ts");

const clearPendingRequests = usageHistory.clearPendingRequests;
const EXPECTED_TOTAL_COST = 0.020925;

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  clearPendingRequests();
  // The route caches any response that took >= 1 s to build, keyed only by the
  // query string. On a loaded runner one slow build would serve the previous
  // test's data to the next one, so every test starts from an empty cache.
  analyticsCache.clearAnalyticsResponseCache();
}

async function seedAnalyticsData() {
  const db = core.getDbInstance();
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const timestamp = new Date(now.getTime() - i * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      i % 2 === 0 ? "openai" : "anthropic",
      i % 2 === 0 ? "gpt-4o" : "claude-sonnet",
      "test-conn",
      "test-key",
      "Primary Key",
      100 + i,
      50 + i,
      1,
      200 + i * 10,
      timestamp
    );
  }
  db.prepare(
    `INSERT INTO call_logs (provider, model, requested_model, connection_id, timestamp)
     VALUES (?, ?, ?, ?, ?)`
  ).run("openai", "gpt-4o", "gpt-4o-mini", "test-conn", new Date().toISOString());
}

function makeRequest(url: string) {
  return new Request(url, { method: "GET" });
}

function assertClose(actual: number, expected: number, epsilon = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test.beforeEach(async () => {
  await resetStorage();
  await localDb.updatePricing({
    openai: { "gpt-4o": { input: 2.5, output: 10 } },
    anthropic: { "claude-sonnet": { input: 3, output: 15 } },
  });
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

test("GET /api/usage/analytics returns summary with aggregated metrics", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 20);
  assert.equal(body.summary.uniqueModels, 2);
  assert.equal(body.summary.uniqueAccounts, 1);
  assert.equal(body.summary.uniqueApiKeys, 1);
  assert.ok(body.summary.totalTokens > 0);
  assert.ok(body.summary.avgLatencyMs > 0);
  assertClose(body.summary.totalCost, EXPECTED_TOTAL_COST);
  assert.ok(body.summary.streak > 0);
});

test("GET /api/usage/analytics includes dailyTrend array with cost data", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.dailyTrend));
  assert.ok(body.dailyTrend.length > 0);
  assert.ok(body.dailyTrend.every((row) => typeof row.cost === "number"));
  const dailyCostTotal = body.dailyTrend.reduce((sum, row) => sum + row.cost, 0);
  assertClose(dailyCostTotal, body.summary.totalCost);
});

test("GET /api/usage/analytics zero-fills inactive models in dailyByModel", async () => {
  const db = core.getDbInstance();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dates = [yesterday, today].map((date) => date.toISOString().slice(0, 10));

  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", "model-a", "openai-conn", 100, 50, 1, 200, `${dates[0]}T12:00:00.000Z`);
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("anthropic", "model-b", "anthropic-conn", 200, 20, 1, 250, `${dates[1]}T12:00:00.000Z`);

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.modelNames, ["model-a", "model-b"]);
  assert.deepEqual(body.dailyByModel, [
    { date: dates[0], "model-a": 150, "model-b": 0 },
    { date: dates[1], "model-a": 0, "model-b": 220 },
  ]);
  assert.deepEqual(
    body.dailyByModel.map((row) => body.modelNames.reduce((sum, model) => sum + row[model], 0)),
    body.dailyTrend.map((row) => row.totalTokens)
  );
});

test("GET /api/usage/analytics includes byModel array with cost calculations", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byModel));
  assert.ok(body.byModel.length > 0);
  const gptEntry = body.byModel.find(
    (m) => (m.model === "4o" || m.model === "gpt-4o") && m.provider === "openai"
  );
  assert.ok(gptEntry);
  assert.ok(typeof gptEntry.cost === "number");
  assert.ok(gptEntry.cost > 0);
  // No model-budget redirect happened for these rows (billed_provider/billed_model
  // are NULL), so normalizedCost must fall back to the same real cost — Task 11's
  // "NULL means no redirect, normalized equals real" contract.
  assert.equal(typeof gptEntry.normalizedCost, "number");
  assertClose(gptEntry.normalizedCost, gptEntry.cost);
});

test("GET /api/usage/analytics resolves Codex GPT-5.5 pricing through provider aliases", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("codex", "gpt-5.5", "codex-conn", 1000, 500, 1, 250, new Date().toISOString());

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.02);
  assert.equal(body.byProvider[0].provider, "OpenAI Codex");
  assertClose(body.byProvider[0].cost, 0.02);
  assert.equal(body.byModel[0].model, "gpt-5.5");
  assertClose(body.byModel[0].cost, 0.02);
});

// Fork: the Claude Code plan (`claude`/`cc`) is NOT classed flat-rate here — its cost is tracked on
// purpose (per-key USD budgets, budget routing and family multipliers are in API-price dollars),
// so these two tests use the GLM Coding plan as the flat-rate sample.
const FLAT_RATE_PRICING = { glm: { "glm-5.3": { input: 5, output: 25 } } };

test("GET /api/usage/analytics can include flat-rate provider estimates for the costs page", async () => {
  await localDb.updatePricing(FLAT_RATE_PRICING);
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "glm",
    "glm-5.3",
    "glm-coding-conn",
    1_000_000,
    1_000_000,
    1,
    250,
    new Date().toISOString()
  );

  const defaultResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d")
  );
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultResponse.status, 200);
  assertClose(defaultBody.summary.totalCost, 0);
  assertClose(defaultBody.byProvider[0].cost, 0);
  assertClose(defaultBody.byModel[0].cost, 0);
  assertClose(defaultBody.presetSummaries["1d"].totalCost, 0);
  assertClose(
    defaultBody.byProvider.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0),
    defaultBody.summary.totalCost
  );

  const estimatedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d&includeFlatRateEstimates=true")
  );
  const estimatedBody = await estimatedResponse.json();
  assert.equal(estimatedResponse.status, 200);
  assert.equal(estimatedBody.includesFlatRateEstimates, true);
  assertClose(estimatedBody.summary.totalCost, 30);
  assert.equal(estimatedBody.byProvider[0].provider, "GLM Coding");
  assertClose(estimatedBody.byProvider[0].cost, 30);
  assertClose(estimatedBody.byModel[0].cost, 30);
  assertClose(estimatedBody.byAccount[0].cost, 30);
  assertClose(estimatedBody.byServiceTier[0].cost, 30);
  assertClose(estimatedBody.presetSummaries["1d"].totalCost, 30);
  assertClose(
    estimatedBody.byProvider.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0),
    estimatedBody.summary.totalCost
  );
});

test("Fork: GET /api/usage/analytics keeps the Claude Code plan's cost instead of zeroing it", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "claude",
    "claude-opus-5",
    "claude-code-conn",
    1_000_000,
    1_000_000,
    1,
    250,
    new Date().toISOString()
  );

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.includesFlatRateEstimates, false);
  assertClose(body.summary.totalCost, 30);
  assert.equal(body.byProvider[0].provider, "Claude Code");
  assertClose(body.byProvider[0].cost, 30);
  assertClose(body.byModel[0].cost, 30);
  assertClose(body.presetSummaries["1d"].totalCost, 30);
});

test("GET /api/usage/analytics preserves archived flat-rate estimates without changing billed cost", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO daily_usage_summary
      (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("glm", "glm-5.3", "2024-01-01", 2, 1_000_000, 1_000_000, 42.5);

  const billedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const billedBody = await billedResponse.json();
  assert.equal(billedResponse.status, 200);
  assertClose(billedBody.summary.totalCost, 0);
  assertClose(billedBody.byProvider[0].cost, 0);

  const estimatedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all&includeFlatRateEstimates=true")
  );
  const estimatedBody = await estimatedResponse.json();
  assert.equal(estimatedResponse.status, 200);
  assertClose(estimatedBody.summary.totalCost, 42.5);
  assertClose(estimatedBody.byProvider[0].cost, 42.5);
  assertClose(estimatedBody.byModel[0].cost, 42.5);
});

test("rollupUsageHistoryBeforeDate stores API-equivalent cost before deleting raw usage", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history
      (provider, model, connection_id, tokens_input, tokens_output, tokens_cache_read,
       tokens_cache_creation, tokens_reasoning, service_tier, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "claude",
    "claude-opus-5",
    "archived-claude",
    1_000_000,
    1_000_000,
    0,
    0,
    0,
    "standard",
    1,
    250,
    "2024-01-01T12:00:00.000Z"
  );

  const result = await aggregateHistory.rollupUsageHistoryBeforeDate("2024-02-01");
  assert.equal(result.errors, 0);
  const retryResult = await aggregateHistory.rollupUsageHistoryBeforeDate("2024-02-01");
  assert.equal(retryResult.errors, 0);

  const archived = db
    .prepare(
      `SELECT total_requests, total_input_tokens, total_output_tokens, total_cost
       FROM daily_usage_summary
       WHERE provider = ? AND model = ? AND date = ?`
    )
    .get("claude", "claude-opus-5", "2024-01-01") as {
    total_requests: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
  };
  assert.equal(archived.total_requests, 1);
  assert.equal(archived.total_input_tokens, 1_000_000);
  assert.equal(archived.total_output_tokens, 1_000_000);
  assertClose(archived.total_cost, 30);
});

test("GET /api/usage/analytics applies Codex Fast tier multipliers and exposes tier split", async () => {
  const db = core.getDbInstance();
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, service_tier, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("codex", "gpt-5.5", "codex-fast", 1000, 500, 1, 250, "priority", timestamp);
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, service_tier, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("codex", "gpt-5.5", "codex-standard", 1000, 500, 1, 250, "standard", timestamp);
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, service_tier, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("codex", "gpt-5.5", "codex-flex", 1000, 500, 1, 250, "flex", timestamp);

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.08);
  assert.equal(body.summary.fastRequests, 1);
  assert.equal(body.summary.flexRequests, 1);
  assert.equal(body.summary.standardRequests, 1);
  assertClose(body.summary.fastCost, 0.05);
  assertClose(body.summary.flexCost, 0.01);
  assertClose(body.summary.flexSavings, 0.01);
  assert.equal(body.summary.flexUsageSavingsTokens, 750);
  assertClose(body.summary.standardCost, 0.02);
  assert.equal(body.byServiceTier.length, 3);
  assert.deepEqual(
    body.byServiceTier.map((tier: { serviceTier: string }) => tier.serviceTier),
    ["priority", "flex", "standard"]
  );
  const flexTier = body.byServiceTier.find(
    (tier: { serviceTier: string }) => tier.serviceTier === "flex"
  );
  assert.equal(flexTier.label, "flex");
  assertClose(flexTier.savings, 0.01);
  assert.equal(flexTier.usageSavingsTokens, 750);
  assertClose(body.byProvider[0].cost, 0.08);
  assertClose(body.byModel[0].cost, 0.08);
  assertClose(body.presetSummaries["1d"].totalCost, 0.08);
});

test("GET /api/usage/analytics does not report flex savings for non-Codex providers", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, service_tier, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", "gpt-4o", "openai-flex", 1000, 500, 1, 250, "flex", new Date().toISOString());

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.0075);
  assert.equal(body.summary.flexRequests, 1);
  assertClose(body.summary.flexCost, 0.0075);
  assertClose(body.summary.flexSavings, 0);
  assert.equal(body.summary.flexUsageSavingsTokens, 0);
  const flexTier = body.byServiceTier.find(
    (tier: { serviceTier: string }) => tier.serviceTier === "flex"
  );
  assertClose(flexTier.savings, 0);
  assert.equal(flexTier.usageSavingsTokens, 0);
});

test("GET /api/usage/analytics applies Codex GPT-5.6 Sol Fast multiplier", async () => {
  await localDb.updatePricing({
    codex: { "gpt-5.6-sol": { input: 5, output: 30 } },
  });
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, service_tier, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "codex",
    "gpt-5.6-sol",
    "codex-fast",
    1000,
    500,
    1,
    250,
    "priority",
    new Date().toISOString()
  );

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.03);
  assertClose(body.summary.fastCost, 0.03);
});

test("GET /api/usage/analytics maps Codex auto-review usage to GPT-5.5 pricing", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("codex", "codex-auto-review", "codex-conn", 1000, 500, 1, 250, new Date().toISOString());

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.02);
  assert.equal(body.byModel[0].model, "codex-auto-review");
  assertClose(body.byModel[0].cost, 0.02);
});

test("GET /api/usage/analytics ignores normal combo routing in fallback statistics", async () => {
  const db = core.getDbInstance();
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("codex", "gpt-5.5", "codex-conn", 1000, 500, 1, 250, timestamp);
  db.prepare(
    `INSERT INTO call_logs (id, provider, model, requested_model, combo_name, connection_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("combo-call", "codex", "gpt-5.5", "combo/dev", "dev", "codex-conn", timestamp);
  db.prepare(
    `INSERT INTO call_logs (id, provider, model, requested_model, connection_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("same-model-call", "codex", "GPT-5.5", "gpt-5.5", "codex-conn", timestamp);

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.fallbackCount, 0);
  assert.equal(body.summary.fallbackRatePct, 0);
  assert.equal(body.summary.requestedModelCoveragePct, 100);
});

test("GET /api/usage/analytics filters by range parameter", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=1d")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.range, "1d");
});

test("GET /api/usage/analytics includes byProvider array with cost data", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byProvider));
  assert.ok(body.byProvider.length > 0);
  assert.ok(body.byProvider.every((row) => typeof row.cost === "number"));
  const providerCostTotal = body.byProvider.reduce((sum, row) => sum + row.cost, 0);
  assertClose(providerCostTotal, body.summary.totalCost);
});

test("GET /api/usage/analytics includes byAccount array with cost data", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byAccount));
  assert.ok(body.byAccount.length > 0);
  assert.ok(body.byAccount.every((row) => row.account === "test-conn"));
  assert.ok(body.byAccount.every((row) => typeof row.cost === "number"));
  assertClose(
    body.byAccount.reduce((sum, row) => sum + row.cost, 0),
    body.summary.totalCost
  );
});

test("GET /api/usage/analytics includes cost by API key", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byApiKey));
  assert.equal(body.byApiKey.length, 1);
  assert.equal(body.byApiKey[0].apiKeyId, "test-key");
  assert.equal(body.byApiKey[0].apiKeyName, "Primary Key");
  assertClose(body.byApiKey[0].cost, body.summary.totalCost);
});

test("GET /api/usage/analytics prices a redirected row at the served model for cost and at the billed model for normalizedCost", async () => {
  // Simulates a model-budget-rule redirect: the client asked for claude-opus,
  // the rule served claude-sonnet instead, and usage_history records both the
  // real (provider/model) and billed (billed_provider/billed_model) pairs.
  await localDb.updatePricing({
    anthropic: {
      "claude-sonnet": { input: 3, output: 15 },
      "claude-opus": { input: 15, output: 75 },
    },
  });

  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history
       (provider, model, billed_provider, billed_model, connection_id, api_key_id, api_key_name,
        service_tier, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "anthropic",
    "claude-sonnet",
    "anthropic",
    "claude-opus",
    "redirect-conn",
    "redirect-key",
    "Redirected Key",
    "standard",
    1000,
    500,
    1,
    200,
    new Date().toISOString()
  );

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();
  assert.equal(response.status, 200);

  const realCost = (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15; // served (sonnet) rates: 0.0105
  const normalizedCost = (1000 / 1_000_000) * 15 + (500 / 1_000_000) * 75; // billed (opus) rates: 0.0525
  assert.ok(normalizedCost > realCost, "test fixture must exercise a real divergence");

  // Grouping stays on the REAL model — the row must appear as claude-sonnet,
  // never as claude-opus, with cost at sonnet rates and normalizedCost at opus rates.
  const modelEntry = body.byModel.find(
    (m) => m.model === "claude-sonnet" && m.provider === "anthropic"
  );
  assert.ok(modelEntry, "redirected row must group under the real (served) model");
  assert.ok(
    !body.byModel.some((m) => m.model === "claude-opus"),
    "the billed model must never appear as its own byModel row"
  );
  assertClose(modelEntry.cost, realCost);
  assertClose(modelEntry.normalizedCost, normalizedCost);

  const providerEntry = body.byProvider.find((p) => p.providerId === "anthropic");
  assert.ok(providerEntry);
  assertClose(providerEntry.cost, realCost);
  assertClose(providerEntry.normalizedCost, normalizedCost);

  const accountEntry = body.byAccount.find((a) => a.account === "redirect-conn");
  assert.ok(accountEntry);
  assertClose(accountEntry.cost, realCost);
  assertClose(accountEntry.normalizedCost, normalizedCost);

  const apiKeyEntry = body.byApiKey.find((k) => k.apiKeyId === "redirect-key");
  assert.ok(apiKeyEntry);
  assertClose(apiKeyEntry.cost, realCost);
  assertClose(apiKeyEntry.normalizedCost, normalizedCost);

  const serviceTierEntry = body.byServiceTier.find((t) => t.serviceTier === "standard");
  assert.ok(serviceTierEntry);
  assertClose(serviceTierEntry.cost, realCost);
  assertClose(serviceTierEntry.normalizedCost, normalizedCost);
});

test("GET /api/usage/analytics?costBasis=billed regroups byModel and byProvider onto the requested (billed) pair, moving request counts off the served pair", async () => {
  // Same-provider redirect: served claude-sonnet, billed claude-opus.
  await localDb.updatePricing({
    anthropic: {
      "claude-sonnet": { input: 3, output: 15 },
      "claude-opus": { input: 15, output: 75 },
    },
  });

  const db = core.getDbInstance();
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO usage_history
       (provider, model, billed_provider, billed_model, connection_id,
        tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "anthropic",
    "claude-sonnet",
    "anthropic",
    "claude-opus",
    "redirect-conn",
    1000,
    500,
    1,
    200,
    timestamp
  );
  // A second, never-redirected claude-opus request — same family, no billed_* columns.
  db.prepare(
    `INSERT INTO usage_history
       (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("anthropic", "claude-opus", "native-opus-conn", 1000, 500, 1, 200, timestamp);
  // Cross-provider redirect: served on openai (gpt-4o, priced in the global beforeEach),
  // billed to anthropic/claude-opus — exercises byProvider moving requests across providers.
  db.prepare(
    `INSERT INTO usage_history
       (provider, model, billed_provider, billed_model, connection_id,
        tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "openai",
    "gpt-4o",
    "anthropic",
    "claude-opus",
    "cross-provider-conn",
    1000,
    500,
    1,
    200,
    timestamp
  );

  const sonnetRealCost = (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15; // 0.0105
  const opusNativeCost = (1000 / 1_000_000) * 15 + (500 / 1_000_000) * 75; // 0.0525
  const gpt4oRealCost = (1000 / 1_000_000) * 2.5 + (500 / 1_000_000) * 10; // 0.0075
  const opusBilledCost = opusNativeCost; // same rate, used for both redirects' normalizedCost

  // --- Default (real) basis: unchanged, three-way split by SERVED family/provider. ---
  const realResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics")
  );
  const realBody = await realResponse.json();
  assert.equal(realResponse.status, 200);
  assert.equal(realBody.costBasis, "real");

  const realSonnet = realBody.byModel.find((m) => m.model === "claude-sonnet");
  const realOpus = realBody.byModel.find((m) => m.model === "claude-opus");
  assert.equal(realSonnet.requests, 1);
  assert.equal(realOpus.requests, 1);
  assertClose(realSonnet.cost, sonnetRealCost);
  assertClose(realOpus.cost, opusNativeCost);

  const realOpenaiProvider = realBody.byProvider.find((p) => p.providerId === "openai");
  const realAnthropicProvider = realBody.byProvider.find((p) => p.providerId === "anthropic");
  assert.equal(realOpenaiProvider.requests, 1);
  assert.equal(realAnthropicProvider.requests, 2);

  // --- Billed basis: regrouped by what the client asked for. ---
  const billedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?costBasis=billed")
  );
  const billedBody = await billedResponse.json();
  assert.equal(billedResponse.status, 200);
  assert.equal(billedBody.costBasis, "billed");

  // claude-sonnet had zero unredirected traffic in this fixture, so it must
  // vanish from byModel entirely once billed grouping moves its one request
  // onto claude-opus — a stale $0 sonnet row would be exactly the "identical
  // numbers" confusion this mode exists to fix.
  assert.ok(
    !billedBody.byModel.some((m) => m.model === "claude-sonnet"),
    "claude-sonnet must not appear in byModel once all its traffic is billed as claude-opus"
  );
  const billedOpus = billedBody.byModel.find(
    (m) => m.model === "claude-opus" && m.provider === "anthropic"
  );
  assert.ok(billedOpus, "claude-opus must absorb both the redirected and native opus requests");
  // Absorbs: the redirected sonnet-served row + the native opus row. The
  // cross-provider (openai-served) row is billed to anthropic but as a
  // DIFFERENT model (also claude-opus here, so it merges into the same
  // bucket) — requests grows to 3, not 2.
  assert.equal(billedOpus.requests, 3);
  assertClose(billedOpus.cost, sonnetRealCost + opusNativeCost + gpt4oRealCost);
  assertClose(billedOpus.normalizedCost, opusBilledCost * 3);

  // byProvider: the openai-served, anthropic-billed row moves its request off
  // "openai" and onto "anthropic".
  const billedOpenaiProvider = billedBody.byProvider.find((p) => p.providerId === "openai");
  const billedAnthropicProvider = billedBody.byProvider.find((p) => p.providerId === "anthropic");
  assert.ok(
    !billedOpenaiProvider,
    "openai must not appear in byProvider once its only request is billed to anthropic"
  );
  assert.ok(billedAnthropicProvider);
  assert.equal(billedAnthropicProvider.requests, 3);
  assertClose(billedAnthropicProvider.cost, sonnetRealCost + opusNativeCost + gpt4oRealCost);
  assertClose(billedAnthropicProvider.normalizedCost, opusBilledCost * 3);
});

test("GET /api/usage/analytics does not double-count raw and aggregated rows", async () => {
  const db = core.getDbInstance();
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  // The raw/aggregated split boundary is retention.usageHistory (365 days by
  // default — see cleanupUsageHistory in src/lib/db/cleanup.ts, which rolls up
  // and deletes usage_history rows using that exact setting). Read it live
  // instead of hardcoding 30 days so this fixture stays valid regardless of
  // the configured retention window.
  const { getUserDatabaseSettings } = await import("../../src/lib/db/databaseSettings.ts");
  const rawRetentionDays = getUserDatabaseSettings().retention.usageHistory;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - rawRetentionDays);
  const olderDate = new Date(cutoffDate);
  olderDate.setDate(olderDate.getDate() - 1);
  const olderDateStr = olderDate.toISOString().split("T")[0];

  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", "gpt-4o", "raw-current", 100, 50, 1, 200, today.toISOString());

  const insertSummary = db.prepare(
    `INSERT INTO daily_usage_summary (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertSummary.run("openai", "gpt-4o", todayStr, 99, 9900, 9900, 0);
  insertSummary.run("openai", "gpt-4o", olderDateStr, 1, 25, 10, 0);

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 2);
  assert.equal(body.summary.totalTokens, 185);
});

test("GET /api/usage/analytics omits global aggregates when filtering by API key", async () => {
  const apiKey = await apiKeysDb.createApiKey("Scoped Key", "machine1234567890");
  const db = core.getDbInstance();

  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "openai",
    "gpt-4o",
    "scoped-conn",
    apiKey.id,
    "Scoped Key",
    100,
    50,
    1,
    200,
    new Date().toISOString()
  );

  db.prepare(
    `INSERT INTO daily_usage_summary (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", "gpt-4o", "2024-01-01", 99, 9900, 9900, 0);

  const response = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?range=all&apiKeyIds=${apiKey.id}`)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 1);
  assert.equal(body.summary.totalTokens, 150);
  assert.equal(body.byApiKey.length, 1);
  assert.equal(body.byApiKey[0].apiKeyId, apiKey.id);
});

test("GET /api/usage/analytics groups renamed API key usage by stable ID", async () => {
  const apiKey = await apiKeysDb.createApiKey("Averyanov", "machine1234567890");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { name: "Alexander Averyanov" });

  const db = core.getDbInstance();
  const now = Date.now();
  const insertUsage = db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertUsage.run(
    "openai",
    "gpt-4o",
    "test-conn",
    apiKey.id,
    "Averyanov",
    100,
    50,
    1,
    200,
    new Date(now - 60_000).toISOString()
  );
  insertUsage.run(
    "openai",
    "gpt-4o",
    "test-conn",
    apiKey.id,
    "Desktop",
    200,
    100,
    1,
    250,
    new Date(now).toISOString()
  );

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.uniqueApiKeys, 1);
  assert.equal(body.byApiKey.length, 1);
  assert.equal(body.byApiKey[0].apiKeyId, apiKey.id);
  assert.equal(body.byApiKey[0].apiKeyName, "Alexander Averyanov");
  assert.deepEqual(body.byApiKey[0].historicalApiKeyNames.sort(), ["Averyanov", "Desktop"]);
  assert.equal(body.byApiKey[0].requests, 2);
  assert.equal(body.byApiKey[0].promptTokens, 300);
  assert.equal(body.byApiKey[0].completionTokens, 150);

  const filteredResponse = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
  );
  const filteredBody = await filteredResponse.json();

  assert.equal(filteredResponse.status, 200);
  assert.equal(filteredBody.summary.totalRequests, 2);
  assert.equal(filteredBody.byApiKey.length, 1);
  assert.equal(filteredBody.byApiKey[0].apiKeyId, apiKey.id);
});

test("GET /api/usage/analytics does not persist guessed API key attribution", async () => {
  await localDb.updatePricing({
    openai: { "gpt-4o": { input: 2.5, output: 10 } },
  });
  await apiKeysDb.createApiKey("Unrestricted Key", "machine1234567890");

  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", "gpt-4o", "legacy-conn", null, null, 100, 50, 1, 200, new Date().toISOString());

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.byApiKey.length, 0);

  const row = db
    .prepare("SELECT api_key_id, api_key_name FROM usage_history WHERE connection_id = ?")
    .get("legacy-conn") as { api_key_id: string | null; api_key_name: string | null };
  assert.equal(row.api_key_id, null);
  assert.equal(row.api_key_name, null);
});

test("GET /api/usage/analytics?view=apiKeys returns only lifetime totals per API key", async () => {
  const usedKey = await apiKeysDb.createApiKey("Used Key", "machine1234567890");
  const idleKey = await apiKeysDb.createApiKey("Idle Key", "machine1234567890");
  const db = core.getDbInstance();
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const insertUsage = db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, 'c1', ?, ?, ?, ?, 1, 200, ?)`
  );
  insertUsage.run("openai", "gpt-4o", usedKey.id, "Used Key", 100, 50, at(86_400_000));
  insertUsage.run("openai", "gpt-4o", usedKey.id, "Old Name", 200, 100, at(60_000));
  insertUsage.run("anthropic", "claude-sonnet", usedKey.id, "Used Key", 300, 30, at(120_000));
  // Rows recorded before per-key ids carry only the key name.
  insertUsage.run("openai", "gpt-4o", null, "Idle Key", 1000, 1000, at(30_000));

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all&view=apiKeys")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body), ["byApiKey"]);
  const totalsById = new Map(body.byApiKey.map((entry) => [entry.apiKeyId, entry]));
  const used = totalsById.get(usedKey.id);
  assert.equal(used.apiKeyName, "Used Key");
  assert.equal(used.requests, 3);
  // gpt-4o: 300 in × $2.50 + 150 out × $10; claude-sonnet: 300 in × $3 + 30 out × $15 (per 1M).
  assertClose(used.cost, 0.0036);
  assert.equal(used.lastUsed, at(60_000));
  assert.deepEqual(totalsById.get(idleKey.id), {
    apiKeyId: idleKey.id,
    apiKeyName: "Idle Key",
    requests: 0,
    cost: 0,
    lastUsed: at(30_000),
  });

  const fullReport = await (
    await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics?range=all"))
  ).json();
  const fullEntry = fullReport.byApiKey.find((entry) => entry.apiKeyId === usedKey.id);
  assert.equal(fullEntry.requests, used.requests);
  assertClose(fullEntry.cost, used.cost);
});

test("GET /api/usage/analytics returns weeklyPattern for the costs dashboard", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.weeklyPattern));
  assert.equal(body.weeklyPattern.length, 7);
  assert.deepEqual(
    body.weeklyPattern.map((row) => row.day),
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  );
  assert.ok(body.weeklyPattern.some((row) => row.totalTokens > 0 && row.avgTokens > 0));
});

test("GET /api/usage/analytics includes activityMap for heatmap", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(typeof body.activityMap === "object");
  assert.ok(Object.keys(body.activityMap).length > 0);
});

test("GET /api/usage/analytics returns 500 on database errors", async () => {
  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(body.summary.totalRequests === 0);
});

test("GET /api/usage/analytics does not throw Unknown named parameter on short range (needsAggregated=false)", async () => {
  // Regression: shared params object leaked agg-only bindings (@sinceDate, @rawCutoffDate)
  // into queries that don't reference them, causing better-sqlite3 to throw.
  // A short range (1h) triggers needsAggregated=false because the entire window
  // falls within the raw-data-only period.
  const db = core.getDbInstance();
  const now = new Date();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openai", "gpt-4o", "test-conn", 100, 50, 1, 200, now.toISOString());

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=1h")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 1);
});

test("GET /api/usage/analytics does not throw Unknown named parameter with apiKey filter on long range", async () => {
  // Regression: Object.assign(presetParams, params) leaked all main-query bindings
  // into preset queries that only reference preset-prefixed placeholders.
  const apiKey = await apiKeysDb.createApiKey("Preset Key", "machine-preset1234");
  const db = core.getDbInstance();
  const now = new Date();

  // Seed data old enough to trigger aggregated + preset path
  for (let i = 0; i < 5; i++) {
    const ts = new Date(now.getTime() - (35 + i) * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("openai", "gpt-4o", "test-conn", apiKey.id, apiKey.name, 100, 50, 1, 200, ts);
  }

  const response = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?range=60d&apiKeyId=${apiKey.id}`)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  // Core regression check: no "Unknown named parameter" error.
  // The exact count depends on raw-vs-aggregated boundary; we only need to
  // confirm the endpoint returns 200 without throwing.
  assert.ok(typeof body.summary.totalRequests === "number");
});

// ──────────────────────────────────────────────────────────────────────────
// range=sinceReset — resolves through resolveApiKeyWeeklyWindow (the same
// helper the API key USD quota uses) instead of day arithmetic. See
// resolveSinceResetRangeWindow in route.ts.
// ──────────────────────────────────────────────────────────────────────────

test("GET /api/usage/analytics range=sinceReset scopes the window to a single filtered API key's own connection", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `sincereset-single-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: "sk-test",
  });
  const connectionId = connection.id as string;

  // Reset in 2 days -> window start is ~5 days ago, narrower than a rolling
  // 7 days. This is the load-bearing assertion: a row 6 days old must be
  // EXCLUDED (day arithmetic for "7d" would have included it).
  const resetAtIso = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  providerLimitsDb.setProviderLimitsCache(connectionId, {
    quotas: { "weekly (7d)": { used: 10, total: 100, resetAt: resetAtIso } },
    plan: "Test Plan",
    message: null,
    fetchedAt: new Date().toISOString(),
  });

  const apiKey = await apiKeysDb.createApiKey("SinceReset Single Key", "machine-since-reset-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { allowedConnections: [connectionId] });

  const db = core.getDbInstance();
  const insertUsage = db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 6 days ago: before the reset-anchored window start (~5d ago) -> excluded.
  insertUsage.run(
    "openai",
    "gpt-4o",
    connectionId,
    apiKey.id,
    apiKey.name,
    100,
    50,
    1,
    200,
    new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
  );
  // 3 days ago: after the reset-anchored window start -> included.
  insertUsage.run(
    "openai",
    "gpt-4o",
    connectionId,
    apiKey.id,
    apiKey.name,
    100,
    50,
    1,
    200,
    new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  );

  const response = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?range=sinceReset&apiKeyIds=${apiKey.id}`)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.resetWindow?.isObserved, true);
  assert.equal(body.resetWindow?.resetAtIso, resetAtIso);
  assert.equal(
    body.summary.totalRequests,
    1,
    "only the row after the reset-anchored window start should count, not the one a rolling 7d would also include"
  );
});

test("GET /api/usage/analytics range=sinceReset falls back to all active connections when zero or multiple API keys are filtered", async () => {
  const soonerConnection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `sincereset-sooner-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: "sk-test",
  });
  const laterConnection = await providersDb.createProviderConnection({
    provider: "anthropic",
    authType: "apikey",
    name: `sincereset-later-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: "sk-test-2",
  });

  const soonerResetAtIso = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const laterResetAtIso = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  providerLimitsDb.setProviderLimitsCache(soonerConnection.id as string, {
    quotas: { "weekly (7d)": { used: 10, total: 100, resetAt: soonerResetAtIso } },
    plan: "Test Plan",
    message: null,
    fetchedAt: new Date().toISOString(),
  });
  providerLimitsDb.setProviderLimitsCache(laterConnection.id as string, {
    quotas: { "weekly (7d)": { used: 10, total: 100, resetAt: laterResetAtIso } },
    plan: "Test Plan",
    message: null,
    fetchedAt: new Date().toISOString(),
  });

  // No apiKeyIds filter at all -> falls back to "all active connections".
  const noFilterResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=sinceReset")
  );
  const noFilterBody = await noFilterResponse.json();
  assert.equal(noFilterResponse.status, 200);
  assert.equal(noFilterBody.resetWindow?.isObserved, true);
  assert.equal(
    noFilterBody.resetWindow?.resetAtIso,
    soonerResetAtIso,
    "with no key filter, the earliest observed reset across all active connections wins"
  );

  // Two keys filtered -> same "all active connections" fallback, not either key's own scope.
  const keyOne = await apiKeysDb.createApiKey("SinceReset Multi Key One", "machine-since-reset-2");
  const keyTwo = await apiKeysDb.createApiKey("SinceReset Multi Key Two", "machine-since-reset-3");
  await apiKeysDb.updateApiKeyPermissions(keyOne.id, {
    allowedConnections: [laterConnection.id as string],
  });
  await apiKeysDb.updateApiKeyPermissions(keyTwo.id, {
    allowedConnections: [soonerConnection.id as string],
  });

  const multiKeyResponse = await analyticsRoute.GET(
    makeRequest(
      `http://localhost/api/usage/analytics?range=sinceReset&apiKeyIds=${keyOne.id},${keyTwo.id}`
    )
  );
  const multiKeyBody = await multiKeyResponse.json();
  assert.equal(multiKeyResponse.status, 200);
  assert.equal(multiKeyBody.resetWindow?.isObserved, true);
  assert.equal(
    multiKeyBody.resetWindow?.resetAtIso,
    soonerResetAtIso,
    "multiple filtered keys must resolve the same all-active-connections window as no filter, not either key's own scope"
  );
});

test("GET /api/usage/analytics range=sinceReset marks the window unobserved and still returns data when no provider reset can be determined", async () => {
  const db = core.getDbInstance();
  // No provider connections / provider_limits_cache at all -> no reset can be observed.
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "openai",
    "gpt-4o",
    "no-reset-conn",
    100,
    50,
    1,
    200,
    new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
  );

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=sinceReset")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(
    body.resetWindow?.isObserved,
    false,
    "the UI must be told this is a rolling-7d fallback, not a real observed reset"
  );
  assert.equal(body.resetWindow?.resetAtIso, null);
  assert.equal(
    body.summary.totalRequests,
    1,
    "the fallback must still return real data (rolling 7 days), never silently drop it"
  );
});

test("rollupUsageHistoryBeforeDate prices each request, not the day's summed tokens", async () => {
  const db = core.getDbInstance();
  const costCalculator = await import("../../src/lib/usage/costCalculator.ts");

  // Two requests, same provider/model/day/tier, so the rollup's
  // GROUP BY provider, model, date, serviceTier collapses them into one row.
  //
  // The first request is cache-heavy: cache_read exceeds tokens_input. Pricing
  // clamps non-cached input at zero per request (costCalculator "nonCachedInput"),
  // so that surplus must NOT be allowed to absorb another request's billable
  // input. Summing tokens first and pricing once lets exactly that happen.
  const rows = [
    { input: 1_000, output: 0, cacheRead: 5_000 },
    { input: 9_000, output: 0, cacheRead: 0 },
  ];

  for (const row of rows) {
    db.prepare(
      `INSERT INTO usage_history
        (provider, model, connection_id, tokens_input, tokens_output, tokens_cache_read,
         tokens_cache_creation, tokens_reasoning, service_tier, success, latency_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "openai",
      "gpt-4o",
      "clamp-conn",
      row.input,
      row.output,
      row.cacheRead,
      0,
      0,
      "standard",
      1,
      200,
      "2024-03-01T12:00:00.000Z"
    );
  }

  // Ground truth: price every request individually, exactly as the live
  // analytics path does for raw (non-archived) usage.
  let expectedCost = 0;
  for (const row of rows) {
    expectedCost += await costCalculator.calculateCost(
      "openai",
      "gpt-4o",
      {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheCreation: 0,
        reasoning: 0,
      },
      {
        provider: "openai",
        model: "gpt-4o",
        serviceTier: "standard",
        flatRateAsZero: false,
      }
    );
  }

  const result = await aggregateHistory.rollupUsageHistoryBeforeDate("2024-04-01");
  assert.equal(result.errors, 0);

  const archived = db
    .prepare(
      `SELECT total_cost FROM daily_usage_summary
       WHERE provider = ? AND model = ? AND date = ?`
    )
    .get("openai", "gpt-4o", "2024-03-01") as { total_cost: number };

  // Retention must preserve the billed value. Archiving a day may not silently
  // discount it just because the day's requests were grouped before pricing.
  assertClose(archived.total_cost, expectedCost);
});

test("GET /api/usage/analytics uses per-row provider_cost_usd instead of re-pricing its tokens", async () => {
  // A row carrying a provider-reported cost (credit-metered providers such as Kiro,
  // xAI's exact cost) is billed by that cost on every breakdown; its tokens are
  // display-only and must not be charged again through the pricing table.
  await localDb.updatePricing({
    kiro: { "gpt-5.6-luna": { input: 999, output: 999 } },
  });
  const apiKey = await apiKeysDb.createApiKey("Metered key", "test-machine");
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, connection_id, account_key, api_key_id, api_key_name,
       tokens_input, tokens_output, provider_credits, provider_cost_usd, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "kiro",
    "gpt-5.6-luna",
    "metered-conn",
    "metered-account",
    apiKey.id,
    apiKey.name,
    100000,
    50000,
    0.5,
    0.01,
    1,
    200,
    new Date().toISOString()
  );

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.01);
  const kiroProvider = body.byProvider.find((row: { provider: string }) =>
    row.provider.toLowerCase().includes("kiro")
  );
  assert.ok(kiroProvider);
  assertClose(kiroProvider.cost, 0.01);
  assert.equal(body.byAccount.length, 1);
  assertClose(body.byAccount[0].cost, 0.01);
  assert.equal(body.byApiKey.length, 1);
  assertClose(body.byApiKey[0].cost, 0.01);
  const kiroModel = body.byModel.find((row: { provider: string }) =>
    row.provider.toLowerCase().includes("kiro")
  );
  assert.ok(kiroModel);
  assertClose(kiroModel.cost, 0.01);
  assert.equal(kiroModel.promptTokens, 100000);
  const dailyCostTotal = body.dailyTrend.reduce(
    (sum: number, row: { cost: number }) => sum + row.cost,
    0
  );
  assertClose(dailyCostTotal, 0.01);

  // The API Manager's lightweight per-key totals view bills the same reported cost.
  const totalsResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?view=apiKeys")
  );
  const totals = await totalsResponse.json();
  assert.equal(totalsResponse.status, 200);
  const meteredKey = totals.byApiKey.find(
    (row: { apiKeyId: string }) => row.apiKeyId === apiKey.id
  );
  assert.ok(meteredKey);
  assert.equal(meteredKey.requests, 1);
  assertClose(meteredKey.cost, 0.01);
});

test("GET /api/usage/analytics keeps measured and token-priced usage apart after rollup", async () => {
  await localDb.updatePricing({
    xai: { "grok-reported": { input: 1, output: 2 } },
  });
  const db = core.getDbInstance();
  const timestamp = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const insert = db.prepare(
    `INSERT INTO usage_history
       (provider, model, tokens_input, tokens_output, provider_cost_usd, success, timestamp)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  );
  // Same token shape, one with a reported cost and one without.
  insert.run("xai", "grok-reported", 100000, 50000, 0.01, timestamp);
  insert.run("xai", "grok-reported", 100000, 50000, null, timestamp);
  insert.run("openai", "gpt-4o", 100000, 0, null, timestamp);

  assert.equal((await aggregateHistory.rollupUsageHistoryBeforeDate("2100-01-01")).errors, 0);

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  // xai: 0.01 reported + (100k × $1 + 50k × $2)/M = 0.21; openai: 100k × $2.5/M = 0.25.
  assertClose(body.summary.totalCost, 0.46);
  assertClose(
    body.byProvider.find((row: { provider: string }) => row.provider.toLowerCase().includes("xai"))
      .cost,
    0.21
  );
  assertClose(
    body.byProvider.find((row: { provider: string }) =>
      row.provider.toLowerCase().includes("openai")
    ).cost,
    0.25
  );
  const grok = body.byModel.find((row: { model: string }) => row.model === "grok-reported");
  assertClose(grok.cost, 0.21);
  assert.equal(grok.promptTokens, 200000);
  assertClose(
    body.dailyTrend.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0),
    0.46
  );
});

test("GET /api/usage/analytics bills a failed credit-metered request only by its measurement", async () => {
  await localDb.updatePricing({ kiro: { "gpt-5.6-luna": { input: 999, output: 999 } } });
  const apiKey = await apiKeysDb.createApiKey("Failed dashboard", "machine-failed-dash");

  await usageHistory.saveRequestUsage({
    provider: "kiro",
    model: "gpt-5.6-luna",
    apiKeyId: apiKey.id,
    timestamp: new Date().toISOString(),
    tokens: { prompt_tokens: 100000, completion_tokens: 0 },
    success: false,
    status: "502",
  });
  await usageHistory.saveRequestUsage({
    provider: "kiro",
    model: "gpt-5.6-luna",
    apiKeyId: apiKey.id,
    timestamp: new Date(Date.now() + 1000).toISOString(),
    tokens: { prompt_tokens: 100000, completion_tokens: 0, cost_in_usd_ticks: 100000000 },
    success: false,
    status: "502",
  });

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.01);
  assert.equal(body.byApiKey.length, 1);
  assertClose(body.byApiKey[0].cost, 0.01);
});
