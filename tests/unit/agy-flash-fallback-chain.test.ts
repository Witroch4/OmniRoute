import assert from "node:assert/strict";
import test from "node:test";

import { getAntigravityModelFallbacks } from "../../open-sse/config/antigravityModelAliases.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { seedAntigravityVersionCache } from "../../open-sse/services/antigravityVersion.ts";

type ChatCompletionPayload = {
  choices: Array<{ message: { content: string } }>;
};

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

function envelopeModel(init: RequestInit | undefined): string {
  try {
    return JSON.parse(String(init?.body)).model as string;
  } catch {
    return "";
  }
}

test("Flash Low has a bounded fallback chain across live Antigravity model ids", () => {
  assert.deepEqual(getAntigravityModelFallbacks("gemini-3.5-flash-extra-low"), [
    "gemini-3.5-flash-extra-low",
    "gemini-3.5-flash-low",
    "gemini-3.1-flash-lite",
  ]);
});

test("Flash Low retries the Medium upstream id when extra-low returns 400", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  const modelsTried: string[] = [];
  seedAntigravityVersionCache("2026.04.17-test");

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const model = envelopeModel(init);
    modelsTried.push(model);
    return model === "gemini-3.5-flash-extra-low" ? make400(model) : makeSuccessSSE();
  }) as typeof fetch;

  try {
    const result = await executor.execute({
      model: "antigravity/gemini-3.5-flash-low",
      body: { request: { contents: [] } },
      stream: false,
      credentials: { accessToken: "token", projectId: "project-1" },
      log: { debug() {}, warn() {}, info() {} },
    });
    const payload = (await result.response.json()) as ChatCompletionPayload;

    assert.equal(result.response.status, 200);
    assert.equal(payload.choices[0].message.content, "OK");
    assert.deepEqual(modelsTried, ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
