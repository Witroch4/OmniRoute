// Review round 2 of the model-budget confidentiality feature (Task 7).
//
// Round 1 fixed the response body (three shapes) and the response headers/cost for the
// LIVE (non-cached) success path. This file closes two gaps the round-2 review found:
//
// 1. (Critical) The idempotency-replay and semantic-cache-HIT paths built headers from
//    the raw served provider/model, and could hand back a body that did not reflect the
//    CURRENT reader's own redirect state — see chatCore/idempotency.ts and
//    chatCore/semanticCache.ts for the fix and its reasoning.
// 2. (Important) Round 1's tests exercised resolveEchoHeaderValue and the header builders
//    directly, but never invoked chatCore.ts itself — a revert at the real call sites
//    (chatCore.ts's buildNonStreamingResponseHeaders/assembleStreamingResponseHeaders
//    calls, or headerResponseCost) would not have failed that suite. Every test below
//    calls the REAL, unmodified handleChatCore end-to-end (only the upstream `fetch` is
//    mocked), so a revert at any of those call sites fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-budget-cache-confid-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { updatePricing } = await import("../../../src/lib/localDb.ts");
const { clearCache } = await import("../../../src/lib/semanticCache.ts");
const { clearIdempotency } = await import("../../../src/lib/idempotencyLayer.ts");
const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
const { OMNIROUTE_RESPONSE_HEADERS } = await import("../../../src/shared/constants/headers.ts");
const { calculateCost } = await import("../../../src/lib/usage/costCalculator.ts");
const { formatOmniRouteCost } = await import("../../../src/domain/omnirouteResponseMeta.ts");

/**
 * Expected cost at the BILLED (provider, model) pair's rates, computed via the SAME
 * shared `calculateCost` production code uses — proving WHICH pair the header was priced
 * against, not re-deriving pricing math independently. Reads the usage back from the
 * response body rather than assuming a token count: the idempotency-replay and
 * semantic-cache paths hand back a `usage` that can differ from what the mocked upstream
 * literally returned (an existing, unrelated pipeline behavior — see the round-2 report),
 * so asserting against a hand-guessed token count would be testing that behavior by
 * accident instead of testing confidentiality.
 */
async function expectedBilledCost(
  usage: Record<string, number>,
  billedProvider: string,
  billedModel: string
): Promise<string> {
  const cost = await calculateCost(billedProvider, billedModel, usage, {});
  return formatOmniRouteCost(cost);
}

const originalFetch = globalThis.fetch;

function noopLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function buildJsonChatResponse(model: string, text: string, usage: Record<string, number>) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-budget-cache-test",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function buildSseChatResponse(model: string, text: string) {
  return new Response(
    `data: ${JSON.stringify({
      id: "chatcmpl-budget-cache-stream",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text } }],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

async function resetStorage() {
  clearCache();
  clearIdempotency();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function waitForAsyncSideEffects() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function invokeChatCore({
  body,
  provider = "openai",
  model = "gpt-4o-mini",
  billedProvider = null,
  billedModel = null,
  requestHeaders = {},
  responseFactory,
}: {
  body: Record<string, unknown>;
  provider?: string;
  model?: string;
  billedProvider?: string | null;
  billedModel?: string | null;
  requestHeaders?: Record<string, string>;
  responseFactory: (call: { body: unknown }) => Response;
}) {
  const calls: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = async (url: string, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return responseFactory(call);
  };

  try {
    const requestBody = structuredClone(body);
    const result = await handleChatCore({
      body: requestBody,
      modelInfo: { provider, model, extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", ...requestHeaders }),
      },
      userAgent: "unit-test",
      billedProvider,
      billedModel,
    } as never);
    await waitForAsyncSideEffects();
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("[live, non-streaming] a redirected request reports the BILLED pair in header, body, AND cost — not the served one", async () => {
  // Distinct, known per-token rates so the cost header proves WHICH model's rates were
  // used, rather than merely asserting "a number came back" — 100x apart is unmissable.
  await updatePricing({
    openai: { "gpt-4o-mini": { input: 1, output: 1 } },
    claude: { "claude-opus-4-8": { input: 100, output: 200 } },
  });

  const { result, calls } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    billedProvider: "claude",
    billedModel: "claude-opus-4-8",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "redirected live request" }],
    },
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "served-by-sonnet-shaped-model", {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
  });

  assert.equal(calls.length, 1, "the served model must still be the one actually called");
  assert.equal(result.success, true);

  const headers = result.response.headers;
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "claude-opus-4-8");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.provider), "cc"); // getProviderAlias("claude")
  // 10 input * $100/MTok + 5 output * $200/MTok = $0.001 + $0.001 = $0.002 — the BILLED
  // (opus) rate. At the served (gpt-4o-mini) rate this would be $0.000015 instead.
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost), "0.0020000000");

  const payload = (await result.response.json()) as { model: string };
  assert.equal(payload.model, "claude-opus-4-8");
});

test("[live, non-streaming] without a redirect the served pair is reported unchanged (no regression)", async () => {
  await updatePricing({
    openai: { "gpt-4o-mini": { input: 1, output: 1 } },
  });

  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "no redirect here" }],
    },
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "ok", { prompt_tokens: 10, completion_tokens: 5 }),
  });

  const headers = result.response.headers;
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "gpt-4o-mini");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.provider), "openai");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost), "0.0000150000");

  const payload = (await result.response.json()) as { model: string };
  assert.equal(payload.model, "gpt-4o-mini");
});

test("[live, streaming] a redirected request reports the BILLED pair in the streaming response headers", async () => {
  const { result } = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    billedProvider: "claude",
    billedModel: "claude-opus-4-8",
    body: {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "redirected streaming request" }],
    },
    responseFactory: () => buildSseChatResponse("gpt-4o-mini", "streamed"),
  });

  assert.equal(result.success, true);
  const headers = result.response.headers;
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "claude-opus-4-8");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.provider), "cc");
});

test("[idempotency] a replayed hit on a redirected request reports the BILLED pair in header, body, AND cost", async () => {
  await updatePricing({
    openai: { "gpt-4o-mini": { input: 1, output: 1 } },
    claude: { "claude-opus-4-8": { input: 100, output: 200 } },
  });

  const sharedHeaders = { "idempotency-key": "redirected-retry-key" };
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: false,
    messages: [{ role: "user", content: "retry me while redirected" }],
  };
  // A genuine client retry keeps the SAME redirect state across both attempts — the
  // spend window a 5s-apart retry falls in does not change.
  const redirected = { billedProvider: "claude", billedModel: "claude-opus-4-8" };

  const first = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    ...redirected,
    requestHeaders: sharedHeaders,
    body: sharedBody,
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "first-answer", {
        prompt_tokens: 10,
        completion_tokens: 5,
      }),
  });

  const second = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    ...redirected,
    requestHeaders: sharedHeaders,
    body: sharedBody,
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "should-not-run", {
        prompt_tokens: 1,
        completion_tokens: 1,
      }),
  });

  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0, "the replay must not hit the provider again");
  assert.equal(second.result.response.headers.get("X-OmniRoute-Idempotent"), "true");

  const headers = second.result.response.headers;
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "claude-opus-4-8");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.provider), "cc");

  const payload = (await second.result.response.json()) as {
    model: string;
    usage: Record<string, number>;
  };
  assert.equal(payload.model, "claude-opus-4-8");
  // Priced at claude-opus-4-8 (100/200 per MTok), not gpt-4o-mini (1/1 per MTok) — a
  // served-rate mistake here would be ~100x smaller and easily distinguished.
  assert.equal(
    headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost),
    await expectedBilledCost(payload.usage, "claude", "claude-opus-4-8")
  );
});

test("[semantic cache] a HIT for a redirected reader reports the BILLED pair — even though the entry was written by a DIFFERENT, non-redirected request", async () => {
  // This is the decisive scenario: the semantic-cache signature is keyed on the SERVED
  // model + content + temperature/top_p + apiKeyId — NOT on whether the writer was
  // redirected. So a fix that only reorders the WRITE (bakes the writer's own echo into
  // the stored artifact) gets this case wrong: the reader here has a DIFFERENT redirect
  // state than the writer, and must see ITS OWN billed pair regardless of what was
  // stored. See chatCore/semanticCache.ts's doc comment for the reasoning.
  await updatePricing({
    openai: { "gpt-4o-mini": { input: 1, output: 1 } },
    claude: { "claude-opus-4-8": { input: 100, output: 200 } },
  });

  const sharedBody = {
    model: "gpt-4o-mini",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "cacheable across redirect states" }],
  };

  // Writer: NOT redirected — a client that asked for gpt-4o-mini directly.
  const writer = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "cached-answer", {
        prompt_tokens: 10,
        completion_tokens: 5,
      }),
  });
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.result.response.headers.get(OMNIROUTE_RESPONSE_HEADERS.cache), "MISS");
  assert.equal(writer.result.response.headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "gpt-4o-mini");

  // Reader: SAME served model/content (same signature ⇒ same cache entry), but THIS
  // request was itself redirected from claude-opus-4-8.
  const reader = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    billedProvider: "claude",
    billedModel: "claude-opus-4-8",
    body: sharedBody,
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "must-not-run", {
        prompt_tokens: 1,
        completion_tokens: 1,
      }),
  });

  assert.equal(reader.calls.length, 0, "must be served from cache, not the provider");
  const headers = reader.result.response.headers;
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.cache), "HIT");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "claude-opus-4-8");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.provider), "cc");

  const payload = (await reader.result.response.json()) as {
    model: string;
    usage: Record<string, number>;
  };
  assert.equal(payload.model, "claude-opus-4-8");
  // costSavedUsd (X-OmniRoute-Cost-Saved) must be priced at the BILLED rate too — same
  // reasoning as the live-path response-cost header (round 1).
  assert.equal(
    headers.get(OMNIROUTE_RESPONSE_HEADERS.costSaved),
    await expectedBilledCost(payload.usage, "claude", "claude-opus-4-8")
  );
});

test("[semantic cache] a HIT for a NOT-redirected reader still reports the served model, even if an earlier redirected request populated the cache", async () => {
  // Mirror of the test above, in the other direction: proves the fix does not simply
  // "always show billed" — it always shows THIS reader's own resolved value.
  const sharedBody = {
    model: "gpt-4o-mini",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "cacheable in the other direction" }],
  };

  const writer = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    billedProvider: "claude",
    billedModel: "claude-opus-4-8",
    body: sharedBody,
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "cached-answer", {
        prompt_tokens: 10,
        completion_tokens: 5,
      }),
  });
  assert.equal(writer.calls.length, 1);
  assert.equal(
    writer.result.response.headers.get(OMNIROUTE_RESPONSE_HEADERS.model),
    "claude-opus-4-8"
  );

  const reader = await invokeChatCore({
    provider: "openai",
    model: "gpt-4o-mini",
    body: sharedBody,
    responseFactory: () =>
      buildJsonChatResponse("gpt-4o-mini", "must-not-run", {
        prompt_tokens: 1,
        completion_tokens: 1,
      }),
  });

  assert.equal(reader.calls.length, 0);
  const headers = reader.result.response.headers;
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.cache), "HIT");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "gpt-4o-mini");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.provider), "openai");

  const payload = (await reader.result.response.json()) as { model: string };
  assert.equal(payload.model, "gpt-4o-mini");
});
