import test from "node:test";
import assert from "node:assert/strict";

import { AGY_PUBLIC_MODELS } from "../../open-sse/config/agyModels.ts";
import {
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_PUBLIC_MODELS,
  isUserCallableAntigravityModelId,
  resolveAntigravityModelId,
  toClientAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { resolveAntigravityMaxOutputTokens } from "../../open-sse/config/antigravityOutputLimits.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

// 2026-10-10 — Antigravity retired Claude 4.6 and serves Claude 5.5 as three effort tiers
// per family (`agy models`, CLI 1.3.3; a real `claude-sonnet-5-5-low` completion succeeded).
// Before this change the OM catalog advertised the retired 4.6 ids plus a `claude-sonnet-5`
// placeholder; the backend answered the placeholder with HTTP 200 and the text "Claude
// Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.", which a health
// probe reads as healthy — so the dead model stayed in the platform picker.

const FAMILIES = ["opus", "sonnet"] as const;
const TIERS = ["low", "medium", "high"] as const;
const LIVE_IDS = FAMILIES.flatMap((family) => TIERS.map((tier) => `claude-${family}-5-5-${tier}`));
const RETIRED_IDS = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "claude-sonnet-5"];

const agyIds = new Set<string>(AGY_PUBLIC_MODELS.map((m) => m.id));
const antigravityIds = new Set<string>(ANTIGRAVITY_PUBLIC_MODELS.map((m) => m.id));

test("both catalogs advertise every Claude 5.5 tier and none of the retired ids", () => {
  for (const id of LIVE_IDS) {
    assert.ok(agyIds.has(id), `agy catalog must advertise ${id}`);
    assert.ok(antigravityIds.has(id), `antigravity catalog must advertise ${id}`);
  }
  for (const id of RETIRED_IDS) {
    assert.ok(!agyIds.has(id), `agy catalog must not advertise retired ${id}`);
    assert.ok(!antigravityIds.has(id), `antigravity catalog must not advertise retired ${id}`);
  }
});

test("agy and antigravity expose the same set of Claude ids (same backend)", () => {
  const claude = (ids: Set<string>) => [...ids].filter((id) => id.startsWith("claude-")).sort();
  assert.deepEqual(claude(agyIds), claude(antigravityIds));
});

test("live tier ids are real upstream ids: no alias, resolve to themselves", () => {
  for (const id of LIVE_IDS) {
    assert.equal(
      (ANTIGRAVITY_MODEL_ALIASES as Record<string, string>)[id],
      undefined,
      `${id} must not be aliased`
    );
    assert.equal(resolveAntigravityModelId(id), id);
    assert.equal(toClientAntigravityModelId(id), id);
    assert.equal(isUserCallableAntigravityModelId(id), true);
  }
});

test("retired ids stay callable as hidden aliases that land on a LIVE tier", () => {
  for (const id of RETIRED_IDS) {
    const target = resolveAntigravityModelId(id);
    assert.notEqual(target, id, `${id} must be remapped`);
    // Resolution is single-step, so the target has to be a live upstream id already.
    assert.ok(LIVE_IDS.includes(target), `${id} -> ${target} must be a live Claude 5.5 tier`);
    assert.equal(resolveAntigravityModelId(target), target, `${target} must be a fixed point`);
    assert.equal(isUserCallableAntigravityModelId(id), true);
  }
  // Legacy display ids point at the same successors.
  assert.equal(resolveAntigravityModelId("gemini-claude-sonnet-4-5"), "claude-sonnet-5-5-high");
  assert.equal(
    resolveAntigravityModelId("gemini-claude-opus-4-5-thinking"),
    "claude-opus-5-5-high"
  );
});

test("the executor dispatches a retired Claude id upstream as the live 5.5 tier", async () => {
  const executor = new AntigravityExecutor();
  const make = () => ({
    project: "project-1",
    userAgent: "antigravity",
    requestId: "agent-1",
    requestType: "agent",
    request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
  });

  const cases: Array<[string, string]> = [
    ["agy/claude-sonnet-4-6", "claude-sonnet-5-5-high"],
    ["antigravity/claude-opus-4-6-thinking", "claude-opus-5-5-high"],
    ["agy/claude-sonnet-5", "claude-sonnet-5-5-high"],
    ["agy/claude-sonnet-5-5-low", "claude-sonnet-5-5-low"],
    ["agy/claude-opus-5-5-medium", "claude-opus-5-5-medium"],
  ];
  for (const [requested, expectedUpstream] of cases) {
    const result = await executor.transformRequest(requested, make(), true, {
      projectId: "project-1",
    });
    if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
    assert.equal((result as { model: string }).model, expectedUpstream, requested);
  }
});

test("Claude 5.5 tiers get the catalog output cap, not an unknown-model surprise", () => {
  for (const id of LIVE_IDS) {
    assert.equal(resolveAntigravityMaxOutputTokens(id), 65536, id);
  }
});
