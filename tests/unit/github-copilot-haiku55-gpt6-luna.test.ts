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
