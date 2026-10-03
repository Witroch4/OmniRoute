/**
 * tests/unit/codex-gpt61-sol.test.ts
 *
 * GPT-6.1 Sol is in OpenAI's public Codex manifest since 2026-09-29 and the account owns
 * it, yet OmniRoute answered `The 'gpt-6.1-sol' model is not supported when using Codex
 * with a ChatGPT account` — byte-identical to the answer for a model that does not exist.
 * The cause was the declared client version (0.156.1): with 0.160.0 the live
 * `/backend-api/codex/models` list carried it and chat + image answered.
 *
 * These lock what makes the model usable and billable: the declared client version, the
 * catalog entry with its effort tiers, a real price (a model with no row bills $0 and
 * escapes the per-key budget rules — that already happened to gpt-6-astra), the image
 * catalog, and that "newest Sol" resolves to it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getCodexClientVersion } from "../../open-sse/config/codexClient.ts";
import { IMAGE_PROVIDERS, parseImageModel } from "../../open-sse/config/imageRegistry.ts";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { resolveModelPricing } from "../../src/lib/usage/pricingResolution.ts";
import { pickNewestFamilyMember } from "../../src/lib/usage/modelFamilyGlob.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";

const TIERS = ["", "-ultra", "-max", "-xhigh", "-high", "-medium", "-low"];

function versionParts(version: string): number[] {
  return version.split(".").map(Number);
}

test("declared Codex client is new enough for GPT-6.1 Sol (0.156.1 was refused)", () => {
  const [major, minor, patch] = versionParts(getCodexClientVersion().replace(/-.*/, ""));
  const declared = major * 1_000_000 + minor * 1_000 + patch;
  assert.ok(declared >= 160_000, `declared ${getCodexClientVersion()} is older than 0.160.0`);
});

test("gpt-6.1-sol is registered with every effort tier, ahead of gpt-6-sol", () => {
  const ids = getModelsByProviderId("codex").map((model) => model.id);
  for (const tier of TIERS) {
    assert.ok(ids.includes(`gpt-6.1-sol${tier}`), `gpt-6.1-sol${tier} must be registered`);
  }
  assert.ok(ids.indexOf("gpt-6.1-sol") < ids.indexOf("gpt-6-sol"));
});

test("gpt-6.1-sol bills at $2 / $10 with the halved $0.10 cache read, on every tier", () => {
  const pricing = getDefaultPricing();
  for (const tier of TIERS) {
    const resolution = resolveModelPricing(pricing, "codex", `gpt-6.1-sol${tier}`);
    assert.equal(resolution.source, "exact", `gpt-6.1-sol${tier} must have its own row`);
    assert.equal(resolution.pricing?.input, 2.0);
    assert.equal(resolution.pricing?.output, 10.0);
    assert.equal(resolution.pricing?.cached, 0.1);
  }
  // the previous generation keeps its own (higher) cache price
  assert.equal(resolveModelPricing(pricing, "codex", "gpt-6-sol").pricing?.cached, 0.2);
});

test("codex image catalog lists gpt-6.1-sol first and the id routes to the codex provider", () => {
  assert.equal(IMAGE_PROVIDERS.codex.models[0].id, "gpt-6.1-sol");
  assert.deepEqual(parseImageModel("cx/gpt-6.1-sol"), {
    provider: "codex",
    model: "gpt-6.1-sol",
  });
});

test("'newest Sol' resolves to 6.1 over 6 and 5.6 (version-numeric, not lexical)", () => {
  assert.equal(
    pickNewestFamilyMember(["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol"], "gpt-*-sol"),
    "gpt-6.1-sol"
  );
});
