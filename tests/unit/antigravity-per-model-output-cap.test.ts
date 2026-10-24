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
import {
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_PUBLIC_MODELS,
} from "../../open-sse/config/antigravityModelAliases.ts";
import {
  AntigravityExecutor,
  MAX_ANTIGRAVITY_OUTPUT_TOKENS,
  __test_applyAntigravityGenerationDefaults as applyAntigravityGenerationDefaults,
} from "../../open-sse/executors/antigravity.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";

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

// ── Executor wiring (upstream per-model cap tests, adapted to the fork table) ──

function generationConfigOf(request: unknown): Record<string, unknown> {
  const gc = (request as Record<string, unknown>)?.generationConfig;
  assert.ok(gc && typeof gc === "object", "expected a generationConfig object on the request");
  return gc as Record<string, unknown>;
}

function clampFor(modelId: string | null | undefined, requested: number): number {
  const request: Record<string, unknown> = {
    generationConfig: { maxOutputTokens: requested },
  };
  applyAntigravityGenerationDefaults(request, modelId);
  return (request.generationConfig as Record<string, unknown>).maxOutputTokens as number;
}

test("each published model is clamped to the limit it declares, not to a shared constant", () => {
  const seen = new Set<number>();

  // Fork catalog: image / computer-use entries are not chat models and declare no limit.
  for (const model of ANTIGRAVITY_PUBLIC_MODELS.filter(
    (entry) => typeof (entry as { maxOutputTokens?: unknown }).maxOutputTokens === "number"
  )) {
    const declared = (model as { maxOutputTokens?: number }).maxOutputTokens;
    assert.equal(
      typeof declared,
      "number",
      `${model.id} declares no maxOutputTokens; the fallback would silently take over`
    );
    seen.add(declared as number);

    // A request far above any published limit comes back at this model's own.
    assert.equal(
      clampFor(model.id, 1_000_000),
      declared,
      `${model.id} should clamp to its declared ${declared}`
    );

    // One token under the limit is not the cap's business.
    assert.equal(clampFor(model.id, (declared as number) - 1), (declared as number) - 1);

    // Exactly at the limit is not clamped either.
    assert.equal(clampFor(model.id, declared as number), declared);
  }

  // If every model agreed on one number, this test would pass even with the
  // old global constant and would prove nothing.
  assert.ok(
    seen.size > 1,
    `expected the catalogue to declare more than one distinct limit, saw ${[...seen].join(", ")}`
  );
});

test("gpt-oss-120b-medium keeps its lower 32768 ceiling", () => {
  // The specific regression a global raise to 65535 would have introduced.
  assert.equal(clampFor("gpt-oss-120b-medium", 65535), 32768);
});

test("gemini-2.5-pro reaches 65535 rather than the old 16384", () => {
  assert.equal(clampFor("gemini-2.5-pro", 65535), 65535);
});

// Fork: an id the pinned catalogs do not know gets DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS (65536),
// never upstream's blanket MAX_ANTIGRAVITY_OUTPUT_TOKENS (16384) — see the header above.
test("an unknown model id falls back to the fork default, not the blanket 16384", () => {
  assert.equal(clampFor("no-such-model-xyz", 1_000_000), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
  assert.notEqual(DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS, MAX_ANTIGRAVITY_OUTPUT_TOKENS);
});

test("retired Antigravity Flash ids cannot inherit provider-neutral output caps", () => {
  for (const modelId of [
    "gemini-3.6-flash-low",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-high",
    "gemini-3.5-flash-extra-low",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "gemini-3-flash-agent",
  ]) {
    // Retired ids never reach the executor (refused in the chat pipeline); if one did, it
    // gets the fork default and never a provider-neutral spec.
    assert.equal(clampFor(modelId, 1_000_000), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS, modelId);
  }
});

test("a missing or empty model id falls back too", () => {
  assert.equal(clampFor(undefined, 1_000_000), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
  assert.equal(clampFor(null, 1_000_000), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
  assert.equal(clampFor("   ", 1_000_000), DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
});

test("the thinkingBudget bump is still clamped by the per-model ceiling", () => {
  // The bump sets floor(budget)+1; on the 32768 model that overshoots.
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingBudget: 60000 },
    },
  };
  applyAntigravityGenerationDefaults(request, "gpt-oss-120b-medium");
  assert.equal((request.generationConfig as Record<string, unknown>).maxOutputTokens, 32768);
});

test("a thinkingBudget bump under the ceiling is left alone", () => {
  // The counterpart to the test above: without this one, a cap that clamped
  // everything down to its own value would still pass, because every
  // assertion in sight would be looking at a clamped number.
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingBudget: 4000 },
    },
  };
  applyAntigravityGenerationDefaults(request, "gpt-oss-120b-medium");
  assert.equal((request.generationConfig as Record<string, unknown>).maxOutputTokens, 4001);
});

test("no maxOutputTokens requested means none is invented", () => {
  const request: Record<string, unknown> = {};
  applyAntigravityGenerationDefaults(request, "gemini-2.5-pro");
  assert.equal((request.generationConfig as Record<string, unknown>).maxOutputTokens, undefined);
});

// The tests above call the defaults helper directly and hand it a model id, so
// they all keep passing if the executor stops passing one. These go through
// transformRequest instead, which is the only path that proves the wiring.

test("the executor passes the resolved model through to the cap", async () => {
  const executor = new AntigravityExecutor();

  const result = await executor.transformRequest(
    "antigravity/gemini-2.5-pro",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 1_000_000 },
      },
    },
    true,
    { projectId: "project-1" }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  // 65535 is this model's declared limit. Reaching MAX_ANTIGRAVITY_OUTPUT_TOKENS
  // here would mean the call site dropped the model argument.
  assert.equal(generationConfigOf(result.request).maxOutputTokens, 65535);
});

test("an aliased id is capped by the model it resolves to", async () => {
  // The two tests around this one use ids that are their own upstream name, so
  // they would pass even if the cap were looked up under the client-facing id.
  // These aliases resolve to a different id, which is the case that separates
  // the two. Image aliases are excluded: they are not user-callable on the chat
  // path (isUserCallableAntigravityModelId is false for them) and never reach
  // the generation defaults.
  const catalogue = new Map(ANTIGRAVITY_PUBLIC_MODELS.map((m) => [m.id, m.maxOutputTokens]));
  const renaming = Object.entries(ANTIGRAVITY_MODEL_ALIASES).filter(
    ([from, to]) => from !== to && catalogue.has(to as string)
  );
  assert.ok(renaming.length > 0, "expected at least one alias that renames to a catalogue model");

  for (const [clientId, upstreamId] of renaming) {
    const expected = catalogue.get(upstreamId as string);
    const executor = new AntigravityExecutor();
    const result = await executor.transformRequest(
      `antigravity/${clientId}`,
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          generationConfig: { maxOutputTokens: 1_000_000 },
        },
      },
      true,
      { projectId: "project-1" }
    );
    if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
    assert.equal(
      generationConfigOf(result.request).maxOutputTokens,
      expected,
      `${clientId} resolves to ${upstreamId}, so it should cap at that model's ${expected}, ` +
        `not at the ${MAX_ANTIGRAVITY_OUTPUT_TOKENS} fallback`
    );
  }
});

test("Gemini 3.8 Flash retains its output allowance above the thinking budget", async () => {
  const executor = new AntigravityExecutor();
  // Fork: tiers are real ids — no `gemini-3.8-flash-tiered` alias.
  for (const model of [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
  ]) {
    const result = await executor.transformRequest(
      `antigravity/${model}`,
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          generationConfig: {
            maxOutputTokens: 65536,
            thinkingConfig: { thinkingBudget: 24576, includeThoughts: true },
          },
        },
      },
      true,
      { projectId: "project-1" }
    );
    if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
    const config = generationConfigOf(result.request);
    assert.equal(config.maxOutputTokens, 65536, model);
    assert.equal((config.thinkingConfig as Record<string, unknown>).thinkingBudget, 24576, model);
  }
});

test("Gemini 3.8 Flash static spec keeps thinking and context, not only the output cap", () => {
  const expectedBudget: Record<string, number> = {
    "gemini-3.8-flash-high": 24576,
    "gemini-3.8-flash-medium": 8192,
    "gemini-3.8-flash-low": 1024,
  };
  for (const model of Object.keys(expectedBudget)) {
    const caps = getResolvedModelCapabilities({
      provider: "antigravity",
      model,
    });
    assert.equal(caps.maxOutputTokens, 65536, model);
    assert.equal(caps.supportsThinking, true, model);
    assert.equal(caps.supportsTools, true, model);
    assert.equal(caps.supportsVision, true, model);
    assert.equal(caps.contextWindow, 1048576, model);
    assert.equal(caps.defaultThinkingBudget, expectedBudget[model], model);
    assert.equal(caps.thinkingBudgetCap, 24576, model);
  }
});

test("the executor's cap differs per model on the same code path", async () => {
  const executor = new AntigravityExecutor();

  const result = await executor.transformRequest(
    "antigravity/gpt-oss-120b-medium",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 1_000_000 },
      },
    },
    true,
    { projectId: "project-1" }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(generationConfigOf(result.request).maxOutputTokens, 32768);
});

// A routed request carries a provider prefix (`agy/...`, `antigravity/...`),
// and cleanModelName strips it before the ceiling is resolved. Nothing states
// that coupling in either function, so a change to the stripping would silently
// route every prefixed request to the fallback. Handing the prefixed id
// straight to the capability lookup returns null, which is what that failure
// would look like.
test("a provider-prefixed model id resolves to the model's ceiling, not the fallback", async () => {
  const cases: Array<[string, number]> = [
    ["agy/gemini-2.5-pro", 65535],
    ["antigravity/gemini-2.5-pro", 65535],
    ["agy/gemini-3.8-flash-high", 65536],
    ["agy/gpt-oss-120b-medium", 32768],
  ];

  for (const [modelId, expected] of cases) {
    const executor = new AntigravityExecutor();
    const result = await executor.transformRequest(
      modelId,
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          generationConfig: { maxOutputTokens: 1_000_000 },
        },
      },
      true,
      { projectId: "project-1" }
    );

    if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
    assert.equal(
      generationConfigOf(result.request).maxOutputTokens,
      expected,
      `${modelId} must cap at ${expected}, not at the ${MAX_ANTIGRAVITY_OUTPUT_TOKENS} fallback`
    );
  }
});
