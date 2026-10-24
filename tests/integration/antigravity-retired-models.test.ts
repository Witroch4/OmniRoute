/**
 * tests/integration/antigravity-retired-models.test.ts
 *
 * End-to-end: a request for a model Google retired on the Antigravity backend is refused by
 * OmniRoute itself — HTTP 404 `model_not_found` with a message that names the successor —
 * instead of being forwarded. `agy`/`antigravity` set `passthroughModels`, so without this the
 * request reached Google, where Gemini 3.5 answered a fixed "no longer available" notice as
 * HTTP 200 and the other retired ids answered 404s that armed the per-model lockout.
 *
 *   1. A direct request is refused before any upstream call, on every alias of the provider.
 *   2. A combo whose first member is retired skips it and is served by the next member.
 *   3. A live Antigravity model is not touched by the refusal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("antigravity-retired-models");
const { BaseExecutor, buildOpenAIResponse, buildRequest, combosDb, handleChat, resetStorage } =
  harness;
const { seedConnection } = harness;

const originalFetch = globalThis.fetch;

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

type ErrorBody = { error: { message: string; type: string; code: string } };

function body(model: string) {
  return { model, stream: false, messages: [{ role: "user", content: `Route ${model}` }] };
}

for (const retired of [
  { model: "agy/gemini-3.5-flash-low", successor: "gemini-3.8-flash-low" },
  { model: "agy/gemini-3.5-flash-high", successor: "gemini-3.8-flash-high" },
  { model: "antigravity/gemini-3.7-flash-medium", successor: "gemini-3.8-flash-medium" },
  { model: "antigravity/gemini-3.6-flash-low", successor: "gemini-3.8-flash-low" },
  { model: "agy/gemini-3.1-pro-high", successor: "gemini-3.8-flash-high" },
  { model: "antigravity/gemini-3-pro-preview", successor: "gemini-3.8-flash-high" },
]) {
  test(`${retired.model} is refused with a clear 404 and never reaches the upstream`, async () => {
    // A usable connection exists on purpose: the refusal must happen before credential
    // selection, not because there was nothing to select.
    await seedConnection(retired.model.split("/")[0], { apiKey: "sk-retired-guard" });
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return buildOpenAIResponse("must not be reached");
    };

    const res = await handleChat(buildRequest({ body: body(retired.model) }));
    const json = (await res.json()) as ErrorBody;

    assert.equal(res.status, 404);
    assert.equal(json.error.code, "model_not_found");
    assert.equal(json.error.type, "invalid_request_error");
    assert.match(json.error.message, /is no longer available/);
    assert.match(json.error.message, /Google retired/);
    assert.ok(
      json.error.message.includes(retired.successor),
      `message must name ${retired.successor}: ${json.error.message}`
    );
    assert.equal(upstreamCalls, 0, "a retired model must not cost an upstream call");
  });
}

test("the ag alias of antigravity is refused as well", async () => {
  await seedConnection("antigravity", { apiKey: "sk-retired-guard-ag" });
  globalThis.fetch = async () => buildOpenAIResponse("must not be reached");

  const res = await handleChat(buildRequest({ body: body("ag/gemini-3.5-flash-medium") }));

  assert.equal(res.status, 404);
  assert.match(((await res.json()) as ErrorBody).error.message, /gemini-3\.8-flash-medium/);
});

test("a combo skips a retired first member and is served by the next one", async () => {
  await seedConnection("agy", { apiKey: "sk-agy-combo" });
  await seedConnection("openai", { apiKey: "sk-openai-combo" });
  await combosDb.createCombo({
    name: "flash-with-retired-head",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    models: ["agy/gemini-3.5-flash-low", "openai/gpt-4o-mini"],
  });

  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return buildOpenAIResponse("Second member answered");
  };

  const res = await handleChat(buildRequest({ body: body("flash-with-retired-head") }));
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };

  assert.equal(res.status, 200, "the combo must fall through to the live member");
  assert.equal(json.choices[0].message.content, "Second member answered");
  assert.equal(urls.length, 1, "only the live member may reach an upstream");
  assert.ok(urls[0].includes("/chat/completions"), `unexpected upstream: ${urls[0]}`);
});

test("a live Antigravity model is not refused", async () => {
  // No connection is seeded on purpose: the request fails fast at credential selection, which
  // proves it got PAST the retirement check without entering the cooldown-retry loop a
  // half-configured agy connection would (3 x 5 s). A retired id never gets that far.
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return buildOpenAIResponse("unused");
  };

  const res = await handleChat(buildRequest({ body: body("agy/gemini-3.8-flash-low") }));
  const text = await res.text();

  assert.doesNotMatch(text, /Google retired/);
  assert.doesNotMatch(text, /is no longer available/);
  assert.match(text, /credentials|connection|provider/i, `expected a credential error: ${text}`);
  assert.equal(upstreamCalls, 0);
});
