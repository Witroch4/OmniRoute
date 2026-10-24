/**
 * #3786 — per-request upstream-id FALLBACK CHAINS for Antigravity (`agy` / `antigravity`).
 *
 * The executor can retry alternative upstream ids on a 400 until one succeeds (2xx) or the
 * chain is exhausted (then the original 400 surfaces, sanitized — hard rule #12). The chains
 * existed for Gemini 3.1 Pro (-high/-low) and Gemini 3.5 Flash Low. Google retired both
 * families (2026-10-23: Pro answers 404, 3.5 answers a fixed "no longer available" notice),
 * so BOTH chain tables are empty and these tests pin the new truth: no chain for a retired or
 * a live id, exactly one upstream call per request, and a 400 surfaces directly.
 *
 * The chain lives at EXECUTOR REQUEST-TIME (retry on 400). It is NOT a change to the static
 * `resolveAntigravityModelId` map, so the #3696 pass-through invariant is unaffected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_FLASH_FALLBACK_CHAINS,
  ANTIGRAVITY_PRO_FALLBACK_CHAINS,
  getAntigravityModelFallbacks,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { seedAntigravityVersionCache } from "../../open-sse/services/antigravityVersion.ts";

type ErrorPayload = {
  error: { code?: string; message: string };
};

// ---------------------------------------------------------------------------
// Pure helper: getAntigravityModelFallbacks
// ---------------------------------------------------------------------------

test("(#3786) both fallback chain tables are empty now that their models are retired", () => {
  assert.deepEqual(ANTIGRAVITY_PRO_FALLBACK_CHAINS, {});
  assert.deepEqual(ANTIGRAVITY_FLASH_FALLBACK_CHAINS, {});
});

test("(#3786) getAntigravityModelFallbacks returns [] for retired and live models alike", () => {
  // Retired families: the chains that used to exist must be gone, not just shortened.
  assert.deepEqual(getAntigravityModelFallbacks("gemini-3.1-pro-high"), []);
  assert.deepEqual(getAntigravityModelFallbacks("gemini-3.1-pro-low"), []);
  assert.deepEqual(getAntigravityModelFallbacks("gemini-3.5-flash-extra-low"), []);
  assert.deepEqual(getAntigravityModelFallbacks("gemini-3.5-flash-low"), []);
  // Live models and the empty id.
  assert.deepEqual(getAntigravityModelFallbacks("gemini-3.8-flash-high"), []);
  assert.deepEqual(getAntigravityModelFallbacks("gemini-2.5-flash"), []);
  assert.deepEqual(getAntigravityModelFallbacks("claude-sonnet-4-6"), []);
  assert.deepEqual(getAntigravityModelFallbacks(""), []);
});

test("(#3786) every chain starts with its own key (each candidate listed once)", () => {
  // Vacuous while both tables are empty; guards any chain added later for a LIVE model.
  for (const chains of [ANTIGRAVITY_PRO_FALLBACK_CHAINS, ANTIGRAVITY_FLASH_FALLBACK_CHAINS]) {
    for (const [key, chain] of Object.entries(chains)) {
      assert.equal(chain[0], key, `chain for ${key} must start with itself`);
      assert.equal(new Set(chain).size, chain.length, `chain for ${key} must have no duplicates`);
    }
  }
});

// ---------------------------------------------------------------------------
// Behavioral: the executor makes exactly one upstream call per request
// ---------------------------------------------------------------------------

function makeSuccessSSE(): Response {
  return new Response(
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function make400(modelId: string): Response {
  return new Response(
    JSON.stringify({ error: { code: 400, message: `Model not found: ${modelId}` } }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

/** Extract the upstream model id from the serialized request envelope. */
function envelopeModel(init: RequestInit | undefined): string {
  try {
    return JSON.parse(String(init?.body)).model as string;
  } catch {
    return "";
  }
}

async function runExecutor(model: string, respond: (modelId: string) => Response) {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  seedAntigravityVersionCache("2026.04.17-test");
  const modelsTried: string[] = [];

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const modelId = envelopeModel(init);
    modelsTried.push(modelId);
    return respond(modelId);
  }) as typeof fetch;

  try {
    const result = await executor.execute({
      model,
      body: { request: { contents: [] } },
      stream: false,
      credentials: { accessToken: "token", projectId: "project-1" },
      log: { debug() {}, warn() {}, info() {} },
    });
    return { result, modelsTried };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("(#3786) happy path on a live tier: first id 200 makes exactly ONE upstream call", async () => {
  const { result, modelsTried } = await runExecutor("antigravity/gemini-3.8-flash-high", () =>
    makeSuccessSSE()
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(modelsTried, ["gemini-3.8-flash-high"], "exactly one call on the happy path");
});

test("(#3786) a 400 on a live model surfaces directly — only the requested id is tried", async () => {
  const { result, modelsTried } = await runExecutor("antigravity/gemini-2.5-flash", make400);

  assert.equal(result.response.status, 400);
  assert.deepEqual(modelsTried, ["gemini-2.5-flash"]);
});

for (const retired of [
  { requested: "antigravity/gemini-3.1-pro-high", upstream: "gemini-3.1-pro-high" },
  { requested: "antigravity/gemini-3.1-pro-low", upstream: "gemini-3.1-pro-low" },
  // 3.5 Flash Low used to be rewritten to the legacy `gemini-3.5-flash-extra-low` and retried
  // on 400; with the alias and the chain gone the id goes upstream verbatim, once.
  { requested: "antigravity/gemini-3.5-flash-low", upstream: "gemini-3.5-flash-low" },
]) {
  test(`(#3786) retired ${retired.upstream} has no chain: one verbatim call, sanitized 400`, async () => {
    const { result, modelsTried } = await runExecutor(retired.requested, make400);
    const payload = (await result.response.json()) as ErrorPayload;

    // Surfaces a real, sanitized 400 — not a masked empty chat.completion.
    assert.equal(result.response.status, 400);
    assert.ok(payload.error, "must carry an error object");
    assert.equal(typeof payload.error.message, "string");
    assert.ok(!payload.error.message.includes("at /"), "no raw stack trace (hard rule #12)");

    // No alias rewrite and no retry: the requested id is the only one tried, once.
    assert.deepEqual(modelsTried, [retired.upstream]);
  });
}
