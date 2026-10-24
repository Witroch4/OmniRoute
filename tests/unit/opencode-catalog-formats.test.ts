/**
 * OpenCode Go serves each model on one wire protocol (chat completions, Responses, Anthropic messages
 * or Google generateContent) and answers 400 ModelProtocolUnsupported on any other. The protocol of a
 * model the static registry does not know used to default to chat completions, so every new
 * Responses/Anthropic/Google model failed until a rebuild. The protocol now comes from the models.dev
 * catalog the official OpenCode CLI reads (`provider.npm` per model), refreshed at runtime.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const catalog = await import("../../open-sse/services/opencodeCatalog.ts");
const { getModelTargetFormat } = await import("../../open-sse/config/providerModels.ts");

const RAW = {
  "opencode-go": {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "brand-new-chat": { provider: { api: "https://opencode.ai/inference/go/openai/v1" } },
      "brand-new-responses": { provider: { npm: "@ai-sdk/openai" } },
      "brand-new-anthropic": { provider: { npm: "@ai-sdk/anthropic" } },
      "brand-new-google": { provider: { npm: "@ai-sdk/google" } },
      "glm-5.3-flash": { provider: { npm: "@ai-sdk/anthropic" } },
    },
  },
  opencode: {
    npm: "@ai-sdk/openai-compatible",
    models: { "zen-only-responses": { provider: { npm: "@ai-sdk/openai" } } },
  },
  openai: { npm: "@ai-sdk/openai", models: { "gpt-6-luna": {} } },
};

function stubFetch(body: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => catalog.resetOpencodeCatalogForTests());

describe("parseOpencodeCatalog", () => {
  it("maps each model's npm package to its wire format, provider npm as the default", () => {
    const parsed = catalog.parseOpencodeCatalog(RAW);
    assert.deepEqual(parsed["opencode-go"], {
      "brand-new-chat": "openai",
      "brand-new-responses": "openai-responses",
      "brand-new-anthropic": "claude",
      "brand-new-google": "gemini",
      "glm-5.3-flash": "claude",
    });
    assert.deepEqual(parsed.opencode, { "zen-only-responses": "openai-responses" });
    assert.equal(parsed.openai, undefined, "only the OpenCode sections are kept");
  });

  it("tolerates a payload without the OpenCode sections", () => {
    assert.deepEqual(catalog.parseOpencodeCatalog({}), {});
    assert.deepEqual(catalog.parseOpencodeCatalog(null), {});
  });
});

describe("getModelTargetFormat with the runtime OpenCode catalog", () => {
  it("routes a model the registry has never seen by the catalog's protocol", async () => {
    const result = await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch(RAW) });
    assert.equal(result.ok, true);
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-anthropic"), "claude");
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-responses"), "openai-responses");
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-google"), "gemini");
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-chat"), null);
  });

  it("falls back to the Zen section for ids the Go section omits", async () => {
    await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch(RAW) });
    assert.equal(getModelTargetFormat("opencode-go", "zen-only-responses"), "openai-responses");
  });

  it("the catalog wins over the static registry", async () => {
    await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch(RAW) });
    assert.equal(getModelTargetFormat("opencode-go", "glm-5.3-flash"), "claude");
  });

  it("without a catalog the static registry still decides", () => {
    assert.equal(getModelTargetFormat("opencode-go", "gpt-6-luna"), "openai-responses");
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-anthropic"), null);
  });

  it("a failed refresh keeps the previous catalog", async () => {
    await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch(RAW) });
    const failed = await catalog.refreshOpencodeCatalog({
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    assert.equal(failed.ok, false);
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-anthropic"), "claude");
  });

  it("an empty or malformed catalog does not replace a good one", async () => {
    await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch(RAW) });
    const empty = await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch({}) });
    assert.equal(empty.ok, false);
    assert.equal(getModelTargetFormat("opencode-go", "brand-new-anthropic"), "claude");
  });

  it("other providers are untouched", async () => {
    await catalog.refreshOpencodeCatalog({ fetchImpl: stubFetch(RAW) });
    assert.equal(getModelTargetFormat("openai", "gpt-6-luna"), null);
    assert.equal(getModelTargetFormat("opencode-zen", "zen-only-responses"), null);
  });

  it("a lookup never reaches the network under the test runner", () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(RAW, calls);
    try {
      getModelTargetFormat("opencode-go", "brand-new-anthropic");
      assert.deepEqual(calls, []);
    } finally {
      globalThis.fetch = original;
    }
  });
});
