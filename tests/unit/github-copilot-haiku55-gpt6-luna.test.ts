/**
 * Claude Haiku 5.5 and GPT-6 Luna on GitHub Copilot (2026-10-12).
 *
 * The account's own GET https://api.githubcopilot.com/models advertises both with
 * policy.state="enabled" and model_picker_enabled=true, yet neither reached
 * `/v1/models`: the gh allowlist is a CLOSED list that gates live discovery and
 * the static fallback, so an entitled model that is not on it is dropped without
 * an error. These tests pin the three things that must hold for a new Copilot id:
 * it is discovered, it is sent to the endpoint the model actually supports, and
 * it is priced (a model with no pricing row bills US$0 and escapes budget rules).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GithubExecutor } from "../../open-sse/executors/github.ts";
import { getModelTargetFormat, getProviderModels } from "../../open-sse/config/providerModels.ts";
import {
  GITHUB_COPILOT_MODEL_ALLOWLIST,
  parseGitHubCopilotModels,
} from "../../open-sse/services/githubCopilotModels.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";
import { resolveModelPricing } from "../../src/lib/usage/pricingResolution.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";

const COPILOT_RESPONSE_SLICE = {
  data: [
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", policy: { state: "enabled" } },
    { id: "gpt-6-luna", name: "GPT-6 Luna", policy: { state: "enabled" } },
    // Present on the account but disabled by GitHub policy: still not on our list.
    { id: "gpt-6-sol", name: "GPT-6 Sol", policy: { state: "disabled" } },
  ],
};

test("live discovery keeps Haiku 5.5 and GPT-6 Luna", () => {
  const ids = parseGitHubCopilotModels(COPILOT_RESPONSE_SLICE).map((model) => model.id);
  assert.deepEqual(ids, ["claude-haiku-5.5", "gpt-6-luna"]);
});

test("both ids are on the allowlist and in the gh registry, in the same order", () => {
  assert.ok(GITHUB_COPILOT_MODEL_ALLOWLIST.includes("claude-haiku-5.5"));
  assert.ok(GITHUB_COPILOT_MODEL_ALLOWLIST.includes("gpt-6-luna"));

  const registryIds = getProviderModels("gh").map((model) => model.id);
  assert.deepEqual(registryIds, [...GITHUB_COPILOT_MODEL_ALLOWLIST]);
});

test("GPT-6 Luna is /responses-only on Copilot, Claude Haiku 5.5 stays on chat/completions", () => {
  assert.equal(getModelTargetFormat("gh", "gpt-6-luna"), "openai-responses");
  assert.equal(getModelTargetFormat("gh", "claude-haiku-5.5"), null);

  const executor = new GithubExecutor();
  assert.equal(
    executor.buildUrl("gpt-6-luna", true),
    "https://api.githubcopilot.com/responses",
    "gpt-6-luna advertises supported_endpoints [/responses, ws:/responses] only"
  );
  assert.equal(
    executor.buildUrl("claude-haiku-5.5", true),
    "https://api.githubcopilot.com/chat/completions",
    "Claude on Copilot never goes to /responses (400 unsupported_api_for_model)"
  );
});

test("registry carries the limits Copilot reports, not Anthropic's first-party ones", () => {
  const byId = new Map(getProviderModels("gh").map((model) => [model.id, model]));

  const haiku = byId.get("claude-haiku-5.5");
  assert.equal(haiku?.contextLength, 200000);
  assert.equal(haiku?.maxOutputTokens, 100000);
  assert.deepEqual(haiku?.unsupportedParams, ["temperature", "top_p", "top_k"]);

  const luna = byId.get("gpt-6-luna");
  assert.equal(luna?.contextLength, 400000);
  assert.equal(luna?.maxOutputTokens, 128000);
});

test("the dotted Copilot id resolves to the Haiku 5.5 model spec", () => {
  const dotted = getModelSpec("claude-haiku-5.5");
  const dashed = getModelSpec("claude-haiku-5-5");
  assert.ok(dotted, "claude-haiku-5.5 must not fall through to no spec");
  assert.equal(dotted, dashed);
  assert.equal(dotted?.adaptiveThinkingOnly, true);
});

test("both ids are priced through the gh provider (never US$0)", () => {
  const catalog = getDefaultPricing();

  const haiku = resolveModelPricing(catalog, "gh", "claude-haiku-5.5");
  assert.notEqual(haiku.source, "missing");
  assert.equal(haiku.pricing?.input, 0.1);
  assert.equal(haiku.pricing?.output, 0.5);

  const luna = resolveModelPricing(catalog, "gh", "gpt-6-luna");
  assert.notEqual(luna.source, "missing");
  assert.equal(luna.pricing?.input, 0.1);
  assert.equal(luna.pricing?.output, 0.5);
});

// --- 2026-10-12, second batch: the rest of what the account lets through -----------

test("Sonnet 5.5, Grok 4.7 and GPT-4.1 are on the allowlist and in the gh registry", () => {
  const allowlist = new Set<string>(GITHUB_COPILOT_MODEL_ALLOWLIST);
  for (const id of ["claude-sonnet-5.5", "grok-4.7", "gpt-4.1"]) {
    assert.ok(allowlist.has(id), `${id} on allowlist`);
  }
  const registryIds = getProviderModels("gh").map((model) => model.id);
  assert.deepEqual(registryIds, [...GITHUB_COPILOT_MODEL_ALLOWLIST]);
});

test("live discovery keeps the second batch and still drops policy-disabled ids", () => {
  const ids = parseGitHubCopilotModels({
    data: [
      { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", policy: { state: "enabled" } },
      { id: "grok-4.7", name: "Grok 4.7" },
      { id: "gpt-4.1", name: "GPT-4.1", policy: { state: "enabled" } },
      // Not on the list: GitHub answers 400 "The requested model is not supported".
      { id: "claude-opus-5.5", name: "Claude Opus 5.5", policy: { state: "disabled" } },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", policy: { state: "disabled" } },
    ],
  }).map((model) => model.id);
  assert.deepEqual(ids, ["claude-sonnet-5.5", "grok-4.7", "gpt-4.1"]);
});

test("Grok 4.7 is /responses-only, Sonnet 5.5 and GPT-4.1 use chat/completions", () => {
  assert.equal(getModelTargetFormat("gh", "grok-4.7"), "openai-responses");
  assert.equal(getModelTargetFormat("gh", "claude-sonnet-5.5"), null);
  assert.equal(getModelTargetFormat("gh", "gpt-4.1"), null);

  const executor = new GithubExecutor();
  assert.equal(executor.buildUrl("grok-4.7", true), "https://api.githubcopilot.com/responses");
  assert.equal(
    executor.buildUrl("claude-sonnet-5.5", true),
    "https://api.githubcopilot.com/chat/completions"
  );
  assert.equal(
    executor.buildUrl("gpt-4.1", true),
    "https://api.githubcopilot.com/chat/completions"
  );
});

test("second batch carries Copilot's own limits", () => {
  const byId = new Map(getProviderModels("gh").map((model) => [model.id, model]));
  assert.equal(byId.get("claude-sonnet-5.5")?.contextLength, 328000);
  assert.equal(byId.get("claude-sonnet-5.5")?.maxOutputTokens, 128000);
  assert.equal(byId.get("grok-4.7")?.contextLength, 328000);
  assert.equal(byId.get("grok-4.7")?.maxOutputTokens, 128000);
  assert.equal(byId.get("gpt-4.1")?.contextLength, 128000);
  assert.equal(byId.get("gpt-4.1")?.maxOutputTokens, 16384);
});

test("Sonnet 5.5 and GPT-4.1 are priced through gh; Grok has no price row (known gap)", () => {
  const catalog = getDefaultPricing();

  const sonnet = resolveModelPricing(catalog, "gh", "claude-sonnet-5.5");
  assert.notEqual(sonnet.source, "missing");
  assert.equal(sonnet.pricing?.input, 2);
  assert.equal(sonnet.pricing?.output, 10);

  const gpt41 = resolveModelPricing(catalog, "gh", "gpt-4.1");
  assert.notEqual(gpt41.source, "missing");

  // Pinned on purpose: when xAI pricing lands this test must be flipped, not forgotten.
  // Grok 4.5/4.6 were already unpriced; 4.7 inherits the gap rather than hiding it.
  assert.equal(resolveModelPricing(catalog, "gh", "grok-4.7").source, "missing");
});
