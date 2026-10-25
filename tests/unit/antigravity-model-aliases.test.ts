import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  getClientVisibleAntigravityModelName,
  isDiscoverableAntigravityModelId,
  isUserCallableAntigravityModelId,
  resolveAntigravityModelId,
  toClientAntigravityModelId,
  toClientAntigravityQuotaModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

function getPublicModel(id: string) {
  return ANTIGRAVITY_PUBLIC_MODELS.find((model) => model.id === id) as any;
}

// #3821-review LEDGER-5 — the upstream quota-bucket → client-tier remap is now the single
// source of truth here (was duplicated as an inline if-ladder in usage.ts). It operates on
// the UPSTREAM quota namespace, where `gemini-3.5-flash-low` is the Medium tier's bucket.
// The 3.5 tier bucket remap table was deliberately left unchanged by the 2026-10-23 catalog
// drop (the 3.5 models left the public catalog, the bucket remap did not), so it is pinned as-is.

// The default `cli` profile wraps the latest user turn like the official CLI; these tests are
// about something else, so compare the text inside the wrapper.
const unwrapCliUserTurn = (text: unknown): unknown =>
  typeof text === "string"
    ? text.replace(
        /^<USER_REQUEST>\n([\s\S]*)\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>[\s\S]*<\/ADDITIONAL_METADATA>$/,
        "$1"
      )
    : text;

test("toClientAntigravityQuotaModelId maps upstream quota buckets to client tiers", () => {
  assert.equal(
    toClientAntigravityQuotaModelId("gemini-3.5-flash-extra-low"),
    "gemini-3.5-flash-low"
  );
  // Dual-meaning id: in the quota namespace this bucket is the Medium tier.
  assert.equal(toClientAntigravityQuotaModelId("gemini-3.5-flash-low"), "gemini-3.5-flash-medium");
  assert.equal(toClientAntigravityQuotaModelId("gemini-3-flash-agent"), "gemini-3.5-flash-high");
  // Non-tier ids fall back to the standard reverse alias map.
  assert.equal(toClientAntigravityQuotaModelId("gemini-3-pro-image"), "gemini-3-pro-image-preview");
  assert.equal(
    toClientAntigravityQuotaModelId("rev19-uic3-1p"),
    "gemini-2.5-computer-use-preview-10-2025"
  );
  // 2026-10-23: Gemini 3.1 Pro was retired and its reverse alias dropped, so its bucket id is
  // no longer rewritten to a client id (it just passes through the standard fallback).
  assert.equal(toClientAntigravityQuotaModelId("gemini-3.1-pro"), "gemini-3.1-pro");
  // Always-allowed bucket passes through unchanged.
  assert.equal(toClientAntigravityQuotaModelId("credits"), "credits");
  // Retired preview buckets are dropped (hidden from clients).
  assert.equal(toClientAntigravityQuotaModelId("gemini-3.5-flash-preview"), null);
  assert.equal(toClientAntigravityQuotaModelId("gemini-3-flash-preview"), null);
  assert.equal(toClientAntigravityQuotaModelId(""), null);
});

test("resolveAntigravityModelId maps the documented Antigravity aliases to upstream IDs", () => {
  assert.equal(resolveAntigravityModelId("gemini-3-pro-image-preview"), "gemini-3-pro-image");
  assert.equal(
    resolveAntigravityModelId("gemini-2.5-computer-use-preview-10-2025"),
    "rev19-uic3-1p"
  );
  // The live Gemini 3.8 Flash tiers are the real upstream ids (no bare id exists): they pass
  // through untouched, so a tier choice is never collapsed (#3696).
  for (const tier of ["low", "medium", "high"]) {
    assert.equal(resolveAntigravityModelId(`gemini-3.8-flash-${tier}`), `gemini-3.8-flash-${tier}`);
  }
  // 2026-10-23: Google retired Gemini 3.5/3.6/3.7 Flash and Gemini 3.1 Pro. Their aliases were
  // dropped, so nothing forwards a retired id (or its old upstream id) to a different model.
  for (const retiredId of [
    "gemini-3-pro-preview",
    "gemini-3.1-pro",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-pro-agent",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "gemini-3.5-flash-preview",
    "gemini-3.5-flash-extra-low",
    "gemini-3-flash-agent",
    "gemini-3.6-flash-high",
    "gemini-3.7-flash-high",
  ]) {
    assert.equal(
      resolveAntigravityModelId(retiredId),
      retiredId,
      `${retiredId} must not be aliased`
    );
  }
  // Claude 4.6 was retired upstream on 2026-10-10; every legacy Claude id now resolves
  // (single step) to a LIVE Claude 5.5 tier.
  assert.equal(resolveAntigravityModelId("gemini-claude-sonnet-4-5"), "claude-sonnet-5-5-high");
  assert.equal(
    resolveAntigravityModelId("gemini-claude-sonnet-4-5-thinking"),
    "claude-sonnet-5-5-high"
  );
  assert.equal(
    resolveAntigravityModelId("gemini-claude-opus-4-5-thinking"),
    "claude-opus-5-5-high"
  );
  assert.equal(resolveAntigravityModelId("claude-sonnet-4-6"), "claude-sonnet-5-5-high");
  assert.equal(resolveAntigravityModelId("claude-opus-4-6-thinking"), "claude-opus-5-5-high");
  assert.equal(resolveAntigravityModelId("claude-sonnet-5"), "claude-sonnet-5-5-high");
  // The live tier ids are real upstream ids: they pass through untouched.
  assert.equal(resolveAntigravityModelId("claude-sonnet-5-5-low"), "claude-sonnet-5-5-low");
  assert.equal(resolveAntigravityModelId("claude-opus-5-5-medium"), "claude-opus-5-5-medium");
  assert.equal(resolveAntigravityModelId("unknown-model"), "unknown-model");
});

test("toClientAntigravityModelId exposes client-visible aliases for known upstream IDs", () => {
  assert.equal(toClientAntigravityModelId("gemini-3-pro-image"), "gemini-3-pro-image-preview");
  assert.equal(
    toClientAntigravityModelId("rev19-uic3-1p"),
    "gemini-2.5-computer-use-preview-10-2025"
  );
  // 2026-10-23: the reverse aliases of the retired upstream ids were dropped with the models.
  for (const retiredUpstreamId of [
    "gemini-3.1-pro",
    "gemini-3.5-flash-extra-low",
    "gemini-3-flash-agent",
  ]) {
    assert.equal(
      toClientAntigravityModelId(retiredUpstreamId),
      retiredUpstreamId,
      `${retiredUpstreamId} must not be reverse-aliased`
    );
  }
  assert.equal(toClientAntigravityModelId("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  assert.equal(toClientAntigravityModelId("gpt-oss-120b-medium"), "gpt-oss-120b-medium");
  assert.equal(toClientAntigravityModelId("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(toClientAntigravityModelId("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
});

test("isUserCallableAntigravityModelId only allows public chat-capable model IDs", () => {
  // Gemini 3.8 Flash is the live Flash line; the tiers are the real upstream ids.
  for (const tier of ["low", "medium", "high"]) {
    assert.equal(isUserCallableAntigravityModelId(`gemini-3.8-flash-${tier}`), true);
  }
  assert.equal(isUserCallableAntigravityModelId("gemini-3.1-flash-lite"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.1-flash-image"), true);
  // Image / computer-use models are callable by both their client id and their upstream id.
  assert.equal(isUserCallableAntigravityModelId("gemini-3-pro-image-preview"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3-pro-image"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-computer-use-preview-10-2025"), true);
  assert.equal(isUserCallableAntigravityModelId("rev19-uic3-1p"), true);
  assert.equal(isUserCallableAntigravityModelId("gpt-oss-120b-medium"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-pro"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-flash"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-flash-lite"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-2.5-flash-thinking"), true);
  // #3184: Claude IS user-callable through the Antigravity OAuth provider (same backend as
  // `agy`, verified empirically). 2026-10-10: the live ids are the 5.5 tiers; the retired
  // 4.6 ids and the `claude-sonnet-5` placeholder stay callable as HIDDEN aliases.
  for (const family of ["opus", "sonnet"]) {
    for (const tier of ["low", "medium", "high"]) {
      assert.equal(isUserCallableAntigravityModelId(`claude-${family}-5-5-${tier}`), true);
    }
  }
  assert.equal(isUserCallableAntigravityModelId("claude-opus-4-6-thinking"), true);
  assert.equal(isUserCallableAntigravityModelId("claude-sonnet-4-6"), true);
  assert.equal(isUserCallableAntigravityModelId("claude-sonnet-5"), true);
  // 2026-10-23: Google retired Gemini 3.5/3.6/3.7 Flash and Gemini 3.1 Pro. They left the
  // public catalog and have no alias, so none of them (nor their old upstream ids) is
  // user-callable any more — requests for them must not be routed upstream as chat models.
  for (const retiredId of [
    "gemini-3-pro-preview",
    "gemini-3.1-pro",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-pro-agent",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "gemini-3.5-flash-preview",
    "gemini-3.5-flash-extra-low",
    "gemini-3-flash-agent",
    "gemini-3.6-flash-low",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-high",
    "gemini-3.7-flash-low",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-high",
  ]) {
    assert.equal(
      isUserCallableAntigravityModelId(retiredId),
      false,
      `${retiredId} is retired and must not be user-callable`
    );
  }
  assert.equal(isUserCallableAntigravityModelId("tab_flash_lite_preview"), false);
  assert.equal(isUserCallableAntigravityModelId("unknown-model"), false);
});

test("isDiscoverableAntigravityModelId accepts new live chat models without a static catalog entry", () => {
  assert.equal(isDiscoverableAntigravityModelId("gemini-3.8-flash-high"), true);
  assert.equal(isDiscoverableAntigravityModelId("claude-sonnet-5"), true);
  assert.equal(isDiscoverableAntigravityModelId("gemini-new-live-tier"), true);

  // Retired ids (upstream's list + the ids the chat pipeline refuses) stay out of discovery…
  for (const retiredId of [
    "gemini-3.5-flash-low",
    "gemini-3.6-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3-flash-agent",
    "gemini-3.1-pro-high",
    "gemini-pro-agent",
    "gemini-3-pro-preview",
  ]) {
    assert.equal(isDiscoverableAntigravityModelId(retiredId), false, retiredId);
  }
  // …but nothing this fork still publishes is retired behind its back (upstream retires 2.5).
  for (const publishedId of [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking",
  ]) {
    assert.equal(isDiscoverableAntigravityModelId(publishedId), true, publishedId);
  }

  assert.equal(isDiscoverableAntigravityModelId("tab_flash_lite_preview"), false);
  assert.equal(isDiscoverableAntigravityModelId("gemini-3.1-flash-image"), false);
  assert.equal(isDiscoverableAntigravityModelId("gemini-3.1-flash-tts-preview"), false);
  assert.equal(isDiscoverableAntigravityModelId("gemini-2.5-flash-preview-tts"), false);
  assert.equal(isDiscoverableAntigravityModelId(""), false);
});

test("ANTIGRAVITY_PUBLIC_MODELS exposes captured Antigravity 2.0.1 names and capabilities", () => {
  // #3184: Claude is exposed in the antigravity catalog (same backend as `agy`, verified).
  // 2026-10-10: Claude 4.6 was retired upstream; the catalog advertises the 5.5 tiers.
  assert.deepEqual(getPublicModel("claude-sonnet-5-5-high"), {
    id: "claude-sonnet-5-5-high",
    name: "Claude Sonnet 5.5 (High)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  });
  assert.equal(getPublicModel("claude-sonnet-5-5-medium").name, "Claude Sonnet 5.5 (Medium)");
  assert.equal(getPublicModel("claude-sonnet-5-5-low").name, "Claude Sonnet 5.5 (Low)");
  assert.equal(getPublicModel("claude-opus-5-5-high").name, "Claude Opus 5.5 (High)");
  assert.equal(getPublicModel("claude-opus-5-5-medium").name, "Claude Opus 5.5 (Medium)");
  assert.equal(getPublicModel("claude-opus-5-5-low").name, "Claude Opus 5.5 (Low)");
  // Retired ids and the `claude-sonnet-5` placeholder are NOT advertised any more (the
  // placeholder used to answer 200 with a "no longer available" text that health probes
  // read as healthy, which kept it alive in the platform picker).
  assert.equal(getPublicModel("claude-opus-4-6-thinking"), undefined);
  assert.equal(getPublicModel("claude-sonnet-4-6"), undefined);
  assert.equal(getPublicModel("claude-sonnet-5"), undefined);
  assert.deepEqual(getPublicModel("gemini-3.8-flash-high"), {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  });
  assert.equal(getPublicModel("gemini-3.8-flash-medium").name, "Gemini 3.8 Flash (Medium)");
  assert.equal(getPublicModel("gemini-3.8-flash-low").name, "Gemini 3.8 Flash (Low)");
  assert.equal(getPublicModel("gemini-3.1-flash-lite").name, "Gemini 3.1 Flash Lite");
  assert.equal(getPublicModel("gemini-3.1-flash-image").name, "Gemini 3.1 Flash Image");
  assert.equal(getPublicModel("gemini-2.5-pro").name, "Gemini 2.5 Pro");
  // 2026-10-23: Google retired Gemini 3.5/3.6/3.7 Flash and Gemini 3.1 Pro — none of them
  // (including the old `gemini-3-pro-preview` / `gemini-pro-agent` ids) is advertised.
  for (const retiredId of [
    "gemini-3-pro-preview",
    "gemini-3.1-pro",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-pro-agent",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "gemini-3.5-flash-preview",
    "gemini-3.6-flash-low",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-high",
    "gemini-3.7-flash-low",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-high",
  ]) {
    assert.equal(getPublicModel(retiredId), undefined, `${retiredId} must not be in the catalog`);
  }
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-3.8-flash-medium"),
    "Gemini 3.8 Flash (Medium)"
  );
  // A retired id has no display name any more: the helper falls back to the id itself.
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-3.5-flash-medium"),
    "gemini-3.5-flash-medium"
  );
  assert.equal(getClientVisibleAntigravityModelName("gemini-2.5-flash"), "Gemini 2.5 Flash");
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-2.5-flash-lite"),
    "Gemini 2.5 Flash Lite"
  );
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-2.5-flash-thinking"),
    "Gemini 2.5 Flash Thinking"
  );
  assert.deepEqual(getPublicModel("gpt-oss-120b-medium"), {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    contextLength: 131072,
    maxOutputTokens: 32768,
    supportsReasoning: true,
    toolCalling: true,
  });
  assert.equal(getPublicModel("gemini-3-pro-image-preview").contextLength, undefined);
  assert.equal(
    getPublicModel("gemini-2.5-computer-use-preview-10-2025").maxOutputTokens,
    undefined
  );
});

test("ANTIGRAVITY_PUBLIC_MODELS has no duplicate model IDs", () => {
  const ids = ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id);
  const seen = new Set<string>();
  const duplicates = ids.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  assert.deepEqual(duplicates, [], `duplicate model IDs found: ${duplicates.join(", ")}`);
});

test("AntigravityExecutor.transformRequest resolves alias models before dispatching upstream", async () => {
  const executor = new AntigravityExecutor();
  const result = await executor.transformRequest(
    "antigravity/gemini-3-pro-image-preview",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    },
    true,
    { projectId: "project-1" }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(result.model, "gemini-3-pro-image");
});

test("AntigravityExecutor.transformRequest dispatches every Gemini 3.8 Flash tier under its own upstream id", async () => {
  const executor = new AntigravityExecutor();
  for (const tier of ["low", "medium", "high"]) {
    const tierId = `gemini-3.8-flash-${tier}`;
    const result = await executor.transformRequest(
      `antigravity/${tierId}`,
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        },
      },
      true,
      { projectId: "project-1" }
    );

    if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
    // The tier ids are the real upstream ids (there is no bare `gemini-3.8-flash`), so the
    // request body is forwarded under the SAME id — the tier choice is never collapsed.
    // (Dropped four assertions on modelConfigId/model_config_id — the executor never sets
    // those fields, so they were vacuously true and gave false confidence.
    // #3821-review LEDGER-10.)
    assert.equal(result.model, tierId);
    assert.deepEqual(
      result.request.contents.map((c: { role: string; parts: Array<{ text: unknown }> }) => ({
        ...c,
        parts: c.parts.map((part) => ({ ...part, text: unwrapCliUserTurn(part.text) })),
      })),
      [{ role: "user", parts: [{ text: "Hello" }] }]
    );
  }
});

test("AntigravityExecutor.transformRequest no longer rewrites retired Gemini 3.5 Flash ids", async () => {
  // 2026-10-23: Gemini 3.5 Flash was retired; the legacy-id aliases that used to forward it
  // (gemini-3.5-flash-high -> gemini-3-flash-agent, ...) are gone, so a stale client id is sent
  // as-is instead of being silently rerouted to another upstream model.
  const executor = new AntigravityExecutor();
  const result = await executor.transformRequest(
    "antigravity/gemini-3.5-flash-high",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    },
    true,
    { projectId: "project-1" }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(result.model, "gemini-3.5-flash-high");
});

test("AntigravityExecutor.transformRequest sends Claude through Gemini-compatible Cloud Code schema", async () => {
  const executor = new AntigravityExecutor();
  const bridged = openaiToAntigravityRequest(
    "claude-opus-4-6-thinking",
    {
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 32_000,
      temperature: 0.5,
      reasoning_effort: "high",
    },
    true,
    { projectId: "project-1" } as any
  );

  const result = await executor.transformRequest(
    "antigravity/claude-opus-4-6-thinking",
    bridged,
    true,
    {
      projectId: "project-1",
    }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  const request = result.request as any;
  assert.deepEqual(
    request.contents.map((c: { role: string; parts: Array<{ text: unknown }> }) => ({
      ...c,
      parts: c.parts.map((part) => ({ ...part, text: unwrapCliUserTurn(part.text) })),
    })),
    [{ role: "user", parts: [{ text: "Hello" }] }]
  );
  // thinkingBudget+1 bump, preserved. The executor clamps to the CALLED MODEL's
  // own pinned ceiling (#4636 originally used a blanket 16384, which flattened
  // this to 16384); `claude-opus-4-6-thinking` advertises 65536, so the bumped
  // value passes through untouched.
  assert.equal(request.generationConfig.maxOutputTokens, 32769);
  assert.equal(request.generationConfig.temperature, 0.5);
  // Default `cli` profile: the official CLI sends no topK/topP (antigravity-cli-envelope).
  assert.equal(request.generationConfig.topK, undefined);
  assert.equal(request.generationConfig.topP, undefined);
  assert.equal(request.messages, undefined);
  assert.equal(request.system, undefined);
  assert.equal(request.max_tokens, undefined);
  assert.equal(request.stream, undefined);
  assert.equal(request.temperature, undefined);
  assert.equal(request.thinking, undefined);
  assert.equal(request.generationConfig.thinkingConfig, undefined);
});
