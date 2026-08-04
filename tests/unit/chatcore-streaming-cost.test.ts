// Characterization of recordStreamingCost — the streaming per-request cost recording extracted
// from handleChatCore's onStreamComplete (chatCore god-file decomposition, #3501). Sync
// fire-and-forget; calculateCost and recordCost are injected, so both are observable without a DB.
// Locks: the guard (missing api-key OR usage → no-op), recordCost with the resolved cost, and the
// estimatedCost<=0 skip.
import { test } from "node:test";
import assert from "node:assert/strict";

const { recordStreamingCost } = await import("../../open-sse/handlers/chatCore/streamingCost.ts");

function spies(costValue: number) {
  const recorded: Array<{ apiKeyId: string; cost: number }> = [];
  const costArgs: Array<{ provider: string; model: string }> = [];
  return {
    recorded,
    costArgs,
    calculateCost: async (provider: string, model: string) => {
      costArgs.push({ provider, model });
      return costValue;
    },
    recordCost: (apiKeyId: string, cost: number) => {
      recorded.push({ apiKeyId, cost });
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("missing apiKeyId → no-op (calculateCost never called)", async () => {
  const s = spies(0.5);
  recordStreamingCost({
    apiKeyId: null,
    provider: "openai",
    model: "gpt-x",
    streamUsage: { prompt_tokens: 10 },
    serviceTier: "standard",
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.costArgs.length, 0);
  assert.equal(s.recorded.length, 0);
});

test("missing streamUsage → no-op", async () => {
  const s = spies(0.5);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: null,
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.costArgs.length, 0);
  assert.equal(s.recorded.length, 0);
});

test("valid input records the resolved cost against the api key", async () => {
  const s = spies(0.0073);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "deepseek",
    model: "deepseek-chat",
    streamUsage: { prompt_tokens: 100, completion_tokens: 50 },
    serviceTier: "standard",
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await waitFor(() => s.recorded.length > 0);
  assert.equal(s.costArgs[0].provider, "deepseek");
  assert.equal(s.recorded.length, 1);
  assert.equal(s.recorded[0].apiKeyId, "key-1");
  assert.equal(s.recorded[0].cost, 0.0073);
});

// Final-review Finding 2: streamingCost.ts previously only ever knew the served
// provider/model, so a redirected streaming request recorded real (served) cost with no
// billed figure at all -- domain_cost_history had nothing for a normalized reader to fall
// back on. billedProvider/billedModel let it record BOTH, mirroring chatCore.ts's
// non-streaming headerResponseCost split.
test("a redirected stream records BOTH the real (served) and billed cost", async () => {
  const recorded: Array<{ apiKeyId: string; cost: number; billedCost: number | null | undefined }> =
    [];
  const costArgs: Array<{ provider: string; model: string }> = [];
  const calculateCost = async (provider: string, model: string) => {
    costArgs.push({ provider, model });
    // Served (cheap) model prices low; billed (requested, expensive) model prices high.
    return model === "claude-sonnet-5" ? 2 : 10;
  };
  const recordCost = (apiKeyId: string, cost: number, billedCost?: number | null) => {
    recorded.push({ apiKeyId, cost, billedCost });
  };

  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "cc",
    model: "claude-sonnet-5",
    streamUsage: { prompt_tokens: 1000, completion_tokens: 500 },
    calculateCost,
    recordCost,
    billedProvider: "cc",
    billedModel: "claude-opus-4-8",
  });

  await waitFor(() => recorded.length > 0);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cost, 2, "real cost stays priced at the SERVED model");
  assert.equal(
    recorded[0].billedCost,
    10,
    "billed cost is priced at the model the client asked for"
  );
  assert.deepEqual(costArgs, [
    { provider: "cc", model: "claude-sonnet-5" },
    { provider: "cc", model: "claude-opus-4-8" },
  ]);
});

test("without a redirect, only the real cost is computed and billedCost is omitted", async () => {
  const s = spies(0.0073);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "deepseek",
    model: "deepseek-chat",
    streamUsage: { prompt_tokens: 100, completion_tokens: 50 },
    calculateCost: s.calculateCost,
    recordCost: (apiKeyId: string, cost: number, billedCost?: number | null) => {
      s.recorded.push({ apiKeyId, cost });
      assert.equal(billedCost, undefined);
    },
  });
  await waitFor(() => s.recorded.length > 0);
  // calculateCost is called exactly once (served only) — no redirect means no second call.
  assert.equal(s.costArgs.length, 1);
});

test("estimatedCost <= 0 does not record", async () => {
  const s = spies(0);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: { prompt_tokens: 1 },
    calculateCost: s.calculateCost,
    recordCost: s.recordCost,
  });
  await waitFor(() => s.costArgs.length > 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.costArgs.length, 1);
  assert.equal(s.recorded.length, 0);
});
