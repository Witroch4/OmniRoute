import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { resolveModelPricing } from "../../src/lib/usage/pricingResolution.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";

test("claude-opus-5-5 is registered newest-first, right before claude-opus-5", () => {
  const ids = getModelsByProviderId("claude").map((model) => model.id);
  const opus55 = ids.indexOf("claude-opus-5-5");
  assert.ok(opus55 >= 0, "claude-opus-5-5 must be registered");
  assert.equal(ids[opus55 + 1], "claude-opus-5");

  const model = getModelsByProviderId("claude").find((m) => m.id === "claude-opus-5-5");
  assert.equal(model?.contextLength, 1000000);
  assert.equal(model?.maxOutputTokens, 128000);
});

test("claude-opus-5-5 bills at its own rates, not the Opus family anchor", () => {
  const resolution = resolveModelPricing(getDefaultPricing(), "claude", "claude-opus-5-5");
  assert.equal(resolution.source, "exact");
  assert.equal(resolution.pricing?.input, 4.0);
  assert.equal(resolution.pricing?.output, 20.0);
  assert.equal(resolution.pricing?.cached, 0.2);
});

test("GPT-6 codex ids bill at the published list prices", () => {
  const pricing = getDefaultPricing();
  const expected: Array<[string, number, number]> = [
    ["gpt-6-astra-high", 10.0, 50.0],
    ["gpt-6-sol", 2.0, 10.0],
    ["gpt-6-sol-ultra", 2.0, 10.0],
    ["gpt-6-luna-low", 0.1, 0.5],
  ];
  for (const [model, input, output] of expected) {
    const resolution = resolveModelPricing(pricing, "codex", model);
    assert.equal(resolution.source, "exact", `${model} must have its own row`);
    assert.equal(resolution.pricing?.input, input, `${model} input`);
    assert.equal(resolution.pricing?.output, output, `${model} output`);
  }
});
