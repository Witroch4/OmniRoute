import assert from "node:assert/strict";
import test from "node:test";

import {
  getAntigravityModelFallbacks,
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_PUBLIC_MODELS,
  ANTIGRAVITY_REVERSE_MODEL_ALIASES,
  isUserCallableAntigravityModelId,
  resolveAntigravityModelId,
  toClientAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { AGY_PUBLIC_MODELS, isUserCallableAgyModelId } from "../../open-sse/config/agyModels.ts";
import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.data.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.ts";

// Fork: the retired set is the one the chat pipeline refuses (antigravityRetiredModels.ts):
// Gemini 3.5/3.6/3.7 Flash, Gemini 3.1 Pro (incl. `gemini-pro-agent`) and
// `gemini-3-pro-preview`. Gemini 2.5 and Computer Use are still published by this fork, so
// upstream's retirement of them does not apply.
const RETIRED_PUBLIC_MODELS = [
  "gemini-3-pro-preview",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.7-flash-tiered",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3-flash-agent",
  "gemini-3.5-flash",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
  "gemini-pro-agent",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
] as const;

const ACTIVE_FLASH_MODEL_IDS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
] as const;

test("Antigravity and AGY publish every live Gemini Flash tier (real tier ids, no -tiered)", () => {
  for (const [provider, models] of [
    ["antigravity", ANTIGRAVITY_PUBLIC_MODELS],
    ["agy", AGY_PUBLIC_MODELS],
  ] as const) {
    const ids = models.map((model) => model.id);
    for (const modelId of ACTIVE_FLASH_MODEL_IDS) {
      assert.ok(ids.includes(modelId), `${provider} must publish ${modelId}`);
    }
    assert.ok(!ids.some((id) => id.endsWith("-tiered")), `${provider}: no -tiered ids`);
  }
});

test("Antigravity excludes confirmed retired models from its public chat catalog", () => {
  const publicModelIds = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));

  for (const modelId of RETIRED_PUBLIC_MODELS) {
    assert.equal(publicModelIds.has(modelId), false, `${modelId} must not be public`);
    assert.equal(
      isUserCallableAntigravityModelId(modelId),
      false,
      `${modelId} must not be discovered as callable`
    );
    assert.equal(isUserCallableAgyModelId(modelId), false, `${modelId} must not be agy-callable`);
  }
});

test("Gemini 3.1 Pro High is neither published nor routed (retired with the 3.1 Pro family)", () => {
  const antigravityModels = new Map(
    ANTIGRAVITY_PUBLIC_MODELS.map((model) => [model.id, model.name])
  );
  const agyModels = new Map(AGY_PUBLIC_MODELS.map((model) => [model.id, model.name]));

  for (const modelId of ["gemini-3.1-pro-high", "gemini-pro-agent"]) {
    assert.equal(antigravityModels.has(modelId), false, modelId);
    assert.equal(agyModels.has(modelId), false, modelId);
    assert.equal(isUserCallableAntigravityModelId(modelId), false, modelId);
    assert.equal(isUserCallableAgyModelId(modelId), false, modelId);
    assert.deepEqual(getAntigravityModelFallbacks(modelId), []);
  }
  // No alias forwards the retired High id to another model.
  assert.equal(resolveAntigravityModelId("gemini-3.1-pro-high"), "gemini-3.1-pro-high");
});

test("Antigravity support catalogs expose every live Gemini 3.8 Flash tier", () => {
  const antigravityModelIds = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));
  const agyModelIds = new Set(AGY_PUBLIC_MODELS.map((model) => model.id));
  const cliAliases = new Set(CLI_TOOLS.antigravity.modelAliases);
  const cliModelIds = new Set(CLI_TOOLS.antigravity.defaultModels.map((model) => model.id));
  const agyFreeModelIds = new Set(
    FREE_MODEL_BUDGETS.filter((model) => model.provider === "agy").map((model) => model.modelId)
  );

  for (const modelId of ACTIVE_FLASH_MODEL_IDS) {
    assert.equal(antigravityModelIds.has(modelId), true, `${modelId} missing from Antigravity`);
    assert.equal(agyModelIds.has(modelId), true, `${modelId} missing from AGY`);
    assert.equal(cliAliases.has(modelId), true, `${modelId} missing from CLI aliases`);
    assert.equal(cliModelIds.has(modelId), true, `${modelId} missing from CLI defaults`);
    assert.equal(agyFreeModelIds.has(modelId), true, `${modelId} missing from AGY metadata`);
  }
});

test("Antigravity support catalogs no longer advertise or price the rejected High id", () => {
  const cliModelIds = CLI_TOOLS.antigravity.defaultModels.map((model) => model.id);
  const pricing = getDefaultPricing().ag;

  assert.equal(cliModelIds.includes("gemini-3.1-pro-high"), false);
  assert.equal(pricing["gemini-3.1-pro-high"], undefined);
});

test("Antigravity and AGY support metadata excludes retired Flash ids", () => {
  const cliAliases = CLI_TOOLS.antigravity.modelAliases;
  const cliModelIds = CLI_TOOLS.antigravity.defaultModels.map((model) => model.id);
  const agyFreeModelIds = FREE_MODEL_BUDGETS.filter((model) => model.provider === "agy").map(
    (model) => model.modelId
  );
  const pricing = getDefaultPricing().ag;

  assert.equal(cliAliases.includes("gemini-3-flash"), false);
  assert.equal(cliModelIds.includes("gemini-3-flash"), false);
  assert.equal(agyFreeModelIds.includes("gemini-3-flash"), false);
  // Removed from static support metadata, but live discovery still admits it: keep it billable (#16570).
  assert.ok(pricing["gemini-3-flash"], "gemini-3-flash must retain Antigravity billing coverage");

  for (const modelId of ACTIVE_FLASH_MODEL_IDS) {
    assert.equal(cliAliases.includes(modelId), true, `${modelId} must remain selectable`);
    assert.equal(cliModelIds.includes(modelId), true, `${modelId} must remain a CLI default`);
    assert.equal(agyFreeModelIds.includes(modelId), true, `${modelId} must remain in AGY metadata`);
    assert.ok(pricing[modelId], `${modelId} must retain Antigravity pricing`);
  }
});

test("Antigravity does not retain routing aliases for confirmed retired models", () => {
  for (const retiredId of [
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3.7-flash",
    "gemini-3.7-flash-high",
    "gemini-3.8-flash-tiered",
  ]) {
    assert.equal(Object.hasOwn(ANTIGRAVITY_MODEL_ALIASES, retiredId), false, retiredId);
  }
  assert.equal(Object.hasOwn(ANTIGRAVITY_REVERSE_MODEL_ALIASES, "gemini-3.1-pro"), false);

  assert.equal(resolveAntigravityModelId("gemini-3-pro-preview"), "gemini-3-pro-preview");
  assert.equal(toClientAntigravityModelId("gemini-3.1-pro"), "gemini-3.1-pro");
});

test("fork: Gemini 2.5 Computer Use stays published with its upstream-id aliases", () => {
  assert.ok(
    ANTIGRAVITY_PUBLIC_MODELS.some(
      (model) => model.id === "gemini-2.5-computer-use-preview-10-2025"
    )
  );
  assert.equal(
    resolveAntigravityModelId("gemini-2.5-computer-use-preview-10-2025"),
    "rev19-uic3-1p"
  );
  assert.equal(
    toClientAntigravityModelId("rev19-uic3-1p"),
    "gemini-2.5-computer-use-preview-10-2025"
  );
});
