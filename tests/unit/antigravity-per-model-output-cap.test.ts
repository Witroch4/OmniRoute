// Per-model output ceiling on the shared Antigravity Cloud Code executor.
//
// Replaces the blanket 16384 cap from decolua/9router#779. Measured in
// production: `agy/gemini-3.7-flash-low` asked for 48000, was silently shrunk
// to 16384, and spent 15731 of those tokens on reasoning — leaving 588 for the
// answer, which truncated mid-JSON. A direct run at 48000 against the same
// connection returned 200 / finishReason=STOP, and the live
// `:fetchAvailableModels` probe advertises 65536 for that family, so the
// blanket cap no longer had a factual basis.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS,
  resolveAntigravityMaxOutputTokens,
} from "../../open-sse/config/antigravityOutputLimits.ts";
import { AGY_PUBLIC_MODELS } from "../../open-sse/config/agyModels.ts";
import { ANTIGRAVITY_PUBLIC_MODELS } from "../../open-sse/config/antigravityModelAliases.ts";

test("the default ceiling is 65536, not the legacy blanket 16384", () => {
  assert.equal(DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS, 65536);
});

test("a pinned model resolves to its OWN catalog ceiling, not the default", () => {
  // gpt-oss-120b-medium advertises 32768 — strictly below the default. This is
  // the case that proves the resolution is per-model rather than a new blanket.
  const pinned = AGY_PUBLIC_MODELS.find((m) => m.id === "gpt-oss-120b-medium");
  assert.ok(pinned, "expected gpt-oss-120b-medium in the agy catalog");
  assert.equal(pinned.maxOutputTokens, 32768);
  assert.equal(resolveAntigravityMaxOutputTokens("gpt-oss-120b-medium"), 32768);
});

test("a pinned 65536 model resolves to 65536", () => {
  assert.equal(resolveAntigravityMaxOutputTokens("claude-sonnet-4-6"), 65536);
  assert.equal(resolveAntigravityMaxOutputTokens("gemini-3.6-flash-high"), 65536);
});

test("a provider-prefixed id resolves the same as the bare id", () => {
  assert.equal(
    resolveAntigravityMaxOutputTokens("agy/gpt-oss-120b-medium"),
    resolveAntigravityMaxOutputTokens("gpt-oss-120b-medium")
  );
  assert.equal(
    resolveAntigravityMaxOutputTokens("antigravity/claude-sonnet-4-6"),
    resolveAntigravityMaxOutputTokens("claude-sonnet-4-6")
  );
});

test("an unpinned passthrough model gets the default, NOT the legacy 16384", () => {
  // gemini-3.7-* is served through `passthroughModels: true` and is absent from
  // both pinned catalogs — exactly the model whose extraction this change fixes.
  assert.equal(resolveAntigravityMaxOutputTokens("gemini-3.7-flash-low"), 65536);
  assert.equal(resolveAntigravityMaxOutputTokens("agy/gemini-3.7-flash-high"), 65536);
  assert.notEqual(resolveAntigravityMaxOutputTokens("gemini-3.7-flash-low"), 16384);
});

test("an empty or missing model id falls back to the default without throwing", () => {
  assert.equal(resolveAntigravityMaxOutputTokens(""), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
  assert.equal(resolveAntigravityMaxOutputTokens(undefined), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
  assert.equal(resolveAntigravityMaxOutputTokens(null), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
});

test("every pinned catalog entry resolves to a positive ceiling", () => {
  const catalogs = [ANTIGRAVITY_PUBLIC_MODELS, AGY_PUBLIC_MODELS] as readonly (readonly {
    id: string;
  }[])[];

  for (const catalog of catalogs) {
    for (const model of catalog) {
      const resolved = resolveAntigravityMaxOutputTokens(model.id);
      assert.ok(
        Number.isFinite(resolved) && resolved > 0,
        `${model.id} resolved to a non-positive ceiling: ${resolved}`
      );
    }
  }
});
