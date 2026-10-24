/**
 * callVisionModel fallback behavior — Integration test (PR #3377, Rule #18)
 *
 * Verifies that when the primary vision model fails, callVisionModel falls
 * through to the next model in the fallback list, and that when ALL models
 * fail it throws the last error (not a silent empty result).
 *
 * Run: node --import tsx/esm --test tests/unit/guardrails/vision-bridge-callmodel.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vision-bridge-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Prevent vision bridge from routing through a real API
process.env.VISION_BRIDGE_ENABLED = "false";

const { callVisionModel } = await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");
const { getFallbackModels } = await import("../../../src/lib/guardrails/visionBridgeRouter.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Helper: build a minimal OpenAI-compat image data URI
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("callVisionModel falls through to next model when primary fails", async () => {
  const FALLBACK_DESCRIPTION = "fallback model description";
  const calls: Array<{ url: string; model: string }> = [];

  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push({ url: String(url), model: String(body.model) });
    if (calls.length === 1) {
      // First call (primary model) — simulate API error
      throw new Error("mock: primary model unavailable");
    }
    // Second call (fallback model) — answer in the wire format of the API the
    // fallback is called through. The router ranks fallbacks by tier, and since
    // credential-less gateways stopped being candidates the top fallback is an
    // Anthropic model (Messages API), not an OpenAI-compatible one.
    const anthropic = String(url).endsWith("/v1/messages");
    const payload = anthropic
      ? { content: [{ type: "text", text: FALLBACK_DESCRIPTION }] }
      : { choices: [{ message: { content: FALLBACK_DESCRIPTION } }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const routerConfig = { fixedModel: "openai/gpt-4o-mini", maxFallbackAttempts: 2 };
  const [expectedFallback] = getFallbackModels("openai/gpt-4o-mini", routerConfig);
  assert.ok(expectedFallback, "the router must offer at least one fallback model");

  const result = await callVisionModel(
    TINY_PNG,
    { model: "openai/gpt-4o-mini", prompt: "Describe this image." },
    "sk-test-key",
    routerConfig
  );

  assert.equal(calls.length, 2, "must have attempted exactly 2 models (primary + 1 fallback)");
  assert.equal(calls[0].model, "gpt-4o-mini", "first attempt is the primary model");
  assert.equal(
    calls[1].model,
    expectedFallback.split("/").slice(1).join("/"),
    "second attempt is the router's first fallback"
  );
  assert.equal(result, FALLBACK_DESCRIPTION, "must return the fallback model's response");
});

test("callVisionModel throws when ALL models fail", async () => {
  let fetchCallCount = 0;

  globalThis.fetch = async () => {
    fetchCallCount++;
    throw new Error(`mock: model-${fetchCallCount} unavailable`);
  };

  await assert.rejects(
    () =>
      callVisionModel(
        TINY_PNG,
        { model: "openai/gpt-4o-mini", prompt: "Describe this image." },
        "sk-test-key",
        { fixedModel: "openai/gpt-4o-mini", maxFallbackAttempts: 2 }
      ),
    (err: Error) => {
      assert.ok(
        err.message.includes("unavailable") || err.message.includes("All vision models failed"),
        `error should indicate failure, got: ${err.message}`
      );
      return true;
    }
  );

  assert.ok(fetchCallCount >= 1, "must have attempted at least 1 model");
});
