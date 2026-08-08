// The test that matters most for the model-family multiplier feature
// (migration 128): all three cost paths — the API key's USD quota
// (apiKeyUsageLimits.ts), the cost dashboard (the analytics route), and the
// write-time `billedCost` fed to `recordCost()` (chatCore's streaming path) —
// must independently arrive at the SAME normalized figure for the SAME
// request, because all three resolve the multiplier through the one shared
// function in src/lib/usage/modelFamilyMultiplier.ts. If they ever disagree,
// the client sees one number, gets blocked by a second, and the dashboard
// shows a third.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-family-multiplier-agreement-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "family-multiplier-agreement-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const analyticsRoute = await import("../../src/app/api/usage/analytics/route.ts");
const familyMultipliersDb = await import("../../src/lib/db/apiKeyModelFamilyMultipliers.ts");
const streamingCost = await import("../../open-sse/handlers/chatCore/streamingCost.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
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

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.beforeEach(async () => {
  await resetStorage();
  await localDb.updatePricing({
    anthropic: {
      "claude-sonnet-5": { input: 3, output: 15 },
      "claude-opus-4-8": { input: 15, output: 75 },
    },
  });
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// 1M input + 0.5M output tokens, priced against the fixture above.
const SONNET_COST = 3 * 1 + 15 * 0.5; // 10.5
const OPUS_COST = 15 * 1 + 75 * 0.5; // 52.5
const MULTIPLIER = 2.5;

// Deterministic stand-in for the real pricing DB lookup used only by the
// write-time (streamingCost.ts) path's injected `calculateCost` — matches the
// SAME fixture prices as the two DB-backed paths above, so all three test the
// SAME numbers via three independently-written code paths, not a shared helper.
async function fixtureCalculateCost(_provider: string, model: string): Promise<number> {
  return model === "claude-sonnet-5" ? SONNET_COST : OPUS_COST;
}

describe("model family multiplier — all three cost paths agree on the same request", () => {
  test("redirected request (served sonnet, billed opus): the OPUS multiplier applies, never sonnet's, and all three paths report the identical normalized figure", async () => {
    const apiKey = await apiKeysDb.createApiKey("Multiplier Agreement Key", "machine-agree-01");
    familyMultipliersDb.replaceFamilyMultipliers(apiKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-opus-*",
        multiplier: MULTIPLIER,
      },
      // A sonnet-family rule with a DIFFERENT multiplier is present too, to prove the
      // billed (opus) rule wins even though sonnet is what actually served the request.
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: 1.1,
      },
    ]);

    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      billedProvider: "anthropic",
      billedModel: "claude-opus-4-8",
      apiKeyId: apiKey.id,
      apiKeyName: "Multiplier Agreement Key",
      connectionId: "agree-conn",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    const expectedRealCost = SONNET_COST; // 10.5 — what actually ran, never multiplied
    const expectedNormalizedCost = OPUS_COST * MULTIPLIER; // 131.25 — billed (opus) family x multiplier

    // ── Path 1: getApiKeyUsdSpendSince — feeds the key's USD quota / @@om-usage ──
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const normalizedSpend = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso);
    assertClose(normalizedSpend, expectedNormalizedCost);
    const realSpend = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso, {
      basis: "real",
    });
    assertClose(realSpend, expectedRealCost);
    assert.notEqual(
      Math.round(realSpend * 100),
      Math.round(normalizedSpend * 100),
      "the multiplier must actually move the normalized figure away from the real one"
    );

    // ── Path 2: the cost dashboard (analytics route), scoped to this one key ──
    const response = await analyticsRoute.GET(
      makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      byApiKey: Array<{ apiKeyId: string | null; cost: number; normalizedCost: number }>;
      byModel: Array<{
        model: string;
        provider: string;
        cost: number;
        normalizedCost: number;
      }>;
    };
    const apiKeyEntry = body.byApiKey.find((k) => k.apiKeyId === apiKey.id);
    assert.ok(apiKeyEntry, "byApiKey must carry this key's own row");
    assertClose(apiKeyEntry.cost, expectedRealCost);
    assertClose(apiKeyEntry.normalizedCost, expectedNormalizedCost);

    const modelEntry = body.byModel.find(
      (m) => m.model === "claude-sonnet-5" && m.provider === "anthropic"
    );
    assert.ok(modelEntry, "the redirected row must group under the real (served) model");
    assert.ok(
      !body.byModel.some((m) => m.model === "claude-opus-4-8"),
      "the billed model must never appear as its own byModel row"
    );
    assertClose(modelEntry.cost, expectedRealCost);
    assertClose(modelEntry.normalizedCost, expectedNormalizedCost);

    // ── Path 3: write-time billedCost fed to recordCost() (persisted normalized figure) ──
    const recorded: Array<{
      apiKeyId: string;
      cost: number;
      billedCost: number | null | undefined;
    }> = [];
    streamingCost.recordStreamingCost({
      apiKeyId: apiKey.id,
      provider: "anthropic",
      model: "claude-sonnet-5",
      billedProvider: "anthropic",
      billedModel: "claude-opus-4-8",
      streamUsage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      calculateCost: fixtureCalculateCost,
      recordCost: (apiKeyId, cost, billedCost) => {
        recorded.push({ apiKeyId, cost, billedCost });
      },
      // No getFamilyMultiplier injected — uses the REAL DB-backed resolver, reading the
      // SAME api_key_model_family_multipliers rows this test wrote via
      // replaceFamilyMultipliers, through the SAME resolveFamilyMultiplier function
      // paths 1 and 2 use.
    });

    await waitFor(() => recorded.length > 0);
    assert.equal(recorded.length, 1);
    assertClose(recorded[0].cost, expectedRealCost);
    assert.equal(typeof recorded[0].billedCost, "number");
    assertClose(recorded[0].billedCost as number, expectedNormalizedCost);

    // All three numbers, computed by three independent code paths, agree exactly.
    assertClose(normalizedSpend, apiKeyEntry.normalizedCost);
    assertClose(apiKeyEntry.normalizedCost, recorded[0].billedCost as number);
  });

  test("direct request (asked AND billed opus, no redirect at all): the multiplier still applies — 'ask the expensive model directly, still pay quota' is the whole point of this feature", async () => {
    const apiKey = await apiKeysDb.createApiKey("Direct Multiplier Key", "machine-agree-02");
    familyMultipliersDb.replaceFamilyMultipliers(apiKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-opus-*",
        multiplier: MULTIPLIER,
      },
    ]);

    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-opus-4-8",
      // No billedProvider/billedModel — this request was never redirected; the client
      // asked for opus and got opus.
      apiKeyId: apiKey.id,
      apiKeyName: "Direct Multiplier Key",
      connectionId: "agree-conn-2",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    const expectedRealCost = OPUS_COST; // 52.5 — real and billed rates are the same model here
    const expectedNormalizedCost = OPUS_COST * MULTIPLIER; // 131.25

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const normalizedSpend = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso);
    assertClose(normalizedSpend, expectedNormalizedCost);
    const realSpend = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso, {
      basis: "real",
    });
    assertClose(realSpend, expectedRealCost);

    const response = await analyticsRoute.GET(
      makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
    );
    const body = (await response.json()) as {
      byApiKey: Array<{ apiKeyId: string | null; cost: number; normalizedCost: number }>;
    };
    const apiKeyEntry = body.byApiKey.find((k) => k.apiKeyId === apiKey.id);
    assert.ok(apiKeyEntry);
    assertClose(apiKeyEntry.cost, expectedRealCost);
    assertClose(apiKeyEntry.normalizedCost, expectedNormalizedCost);

    const recorded: Array<{ billedCost: number | null | undefined }> = [];
    streamingCost.recordStreamingCost({
      apiKeyId: apiKey.id,
      provider: "anthropic",
      model: "claude-opus-4-8",
      // billedProvider/billedModel intentionally omitted — no redirect.
      streamUsage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      calculateCost: fixtureCalculateCost,
      recordCost: (_apiKeyId, _cost, billedCost) => {
        recorded.push({ billedCost });
      },
    });

    await waitFor(() => recorded.length > 0);
    // Even with no redirect, a configured multiplier must still produce an explicit
    // (multiplied) billedCost — this is the write-time analog of the read-time
    // assertions above, and the core new behavior this feature adds.
    assert.equal(typeof recorded[0].billedCost, "number");
    assertClose(recorded[0].billedCost as number, expectedNormalizedCost);
  });

  test("a key with NO multiplier rules configured: normalized cost equals real cost everywhere (absence is neutral, not a special case)", async () => {
    const apiKey = await apiKeysDb.createApiKey("No Multiplier Key", "machine-agree-03");
    // Deliberately no replaceFamilyMultipliers call.

    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKeyId: apiKey.id,
      apiKeyName: "No Multiplier Key",
      connectionId: "agree-conn-3",
      tokens: { input: 1_000_000, output: 500_000 },
      success: true,
      timestamp: new Date().toISOString(),
    });

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const normalizedSpend = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso);
    const realSpend = await usageLimits.getApiKeyUsdSpendSince(apiKey.id, sinceIso, {
      basis: "real",
    });
    assertClose(normalizedSpend, SONNET_COST);
    assertClose(realSpend, SONNET_COST);
    assertClose(normalizedSpend, realSpend);

    const response = await analyticsRoute.GET(
      makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
    );
    const body = (await response.json()) as {
      byApiKey: Array<{ apiKeyId: string | null; cost: number; normalizedCost: number }>;
    };
    const apiKeyEntry = body.byApiKey.find((k) => k.apiKeyId === apiKey.id);
    assert.ok(apiKeyEntry);
    assertClose(apiKeyEntry.cost, apiKeyEntry.normalizedCost);
  });

  test("a SECOND key's multiplier never leaks onto a different key's spend for the identical family", async () => {
    const cheapKey = await apiKeysDb.createApiKey("Unmultiplied Key", "machine-agree-04a");
    const taxedKey = await apiKeysDb.createApiKey("Multiplied Key", "machine-agree-04b");
    familyMultipliersDb.replaceFamilyMultipliers(taxedKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: MULTIPLIER,
      },
    ]);

    for (const [key, name, conn] of [
      [cheapKey, "Unmultiplied Key", "agree-conn-4a"],
      [taxedKey, "Multiplied Key", "agree-conn-4b"],
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

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cheapSpend = await usageLimits.getApiKeyUsdSpendSince(cheapKey.id, sinceIso);
    const taxedSpend = await usageLimits.getApiKeyUsdSpendSince(taxedKey.id, sinceIso);
    assertClose(cheapSpend, SONNET_COST);
    assertClose(taxedSpend, SONNET_COST * MULTIPLIER);
  });
});

describe("write-time persisted billedCost also carries the multiplier for a non-redirected request", () => {
  test("no redirect, but a multiplier applies: recordCost still receives an explicit (multiplied) billedCost, not undefined", async () => {
    const apiKey = await apiKeysDb.createApiKey("Write-Time Multiplier Key", "machine-agree-05");
    familyMultipliersDb.replaceFamilyMultipliers(apiKey.id, [
      {
        enabled: true,
        priority: 0,
        provider: "anthropic",
        familyGlob: "claude-opus-*",
        multiplier: MULTIPLIER,
      },
    ]);

    const recorded: Array<{ billedCost: number | null | undefined }> = [];
    streamingCost.recordStreamingCost({
      apiKeyId: apiKey.id,
      provider: "anthropic",
      model: "claude-opus-4-8",
      streamUsage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      calculateCost: fixtureCalculateCost,
      recordCost: (_apiKeyId, _cost, billedCost) => {
        recorded.push({ billedCost });
      },
    });

    await waitFor(() => recorded.length > 0);
    assert.equal(typeof recorded[0].billedCost, "number");
    assertClose(recorded[0].billedCost as number, OPUS_COST * MULTIPLIER);
  });

  test("no redirect and no multiplier: billedCost stays undefined (pre-existing NULL == real contract, unchanged)", async () => {
    const apiKey = await apiKeysDb.createApiKey("No-op Key", "machine-agree-06");

    const recorded: Array<{ billedCost: number | null | undefined }> = [];
    streamingCost.recordStreamingCost({
      apiKeyId: apiKey.id,
      provider: "anthropic",
      model: "claude-opus-4-8",
      streamUsage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      calculateCost: fixtureCalculateCost,
      recordCost: (_apiKeyId, _cost, billedCost) => {
        recorded.push({ billedCost });
      },
    });

    await waitFor(() => recorded.length > 0);
    assert.equal(recorded[0].billedCost, undefined);
  });
});
