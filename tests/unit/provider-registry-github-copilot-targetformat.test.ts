/**
 * Issue #2911 — Built-in GitHub Copilot Claude Opus / Gemini models fail.
 *
 * The `github` provider has `format: "openai"` (baseUrl .../chat/completions)
 * and a separate `responsesBaseUrl` (.../responses). A model only routes to the
 * Responses API when it sets `targetFormat: "openai-responses"`.
 *
 * GitHub Copilot's Responses API does NOT serve the Claude/Gemini models, so
 * Claude and Gemini models fail with a 400 on that endpoint.
 *
 * Claude uses the native Messages shim; Gemini uses Chat Completions.
 * Models advertised as Responses-only must keep the Responses route.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { getModelsByProviderId } = await import("../../open-sse/config/providerModels.ts");

type ModelEntry = { id: string; targetFormat?: string; [k: string]: unknown };

function githubModel(id: string): ModelEntry | undefined {
  const provider = (REGISTRY as Record<string, { models?: ModelEntry[] }>)["github"];
  return provider?.models?.find((m) => m.id === id);
}

// Claude/Gemini models that must NOT route through the Responses API.
// Fork: the fork account's Copilot picker (upstream's claude-fable-5.1 / claude-opus-5
// are policy-disabled on it and not registered).
const MUST_NOT_BE_RESPONSES = [
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-sonnet-4.6",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "kimi-k3",
];

for (const id of MUST_NOT_BE_RESPONSES) {
  test(`#2911 github/${id} must not use openai-responses targetFormat`, () => {
    const model = githubModel(id);
    assert.ok(model, `${id} must be registered under github`);
    assert.notEqual(
      model.targetFormat,
      "openai-responses",
      `github/${id} must use Messages or Chat Completions`
    );
  });
}

test("#2911 github/claude-sonnet-5 stays on the native Messages format", () => {
  const model = githubModel("claude-sonnet-5");
  assert.ok(model, "claude-sonnet-5 must be registered");
  assert.equal(model.targetFormat, "claude");
});

// Regression guard: models with `/responses` in the curated Copilot catalog keep the Responses API.
for (const id of [
  "gpt-6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "mai-code-1.1-flash",
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5-mini",
  "mai-code-1-flash",
]) {
  test(`#2911 github/${id} still uses openai-responses`, () => {
    const model = githubModel(id);
    assert.ok(model, `${id} must be registered`);
    assert.equal(
      model.targetFormat,
      "openai-responses",
      `github/${id} must keep the Responses API`
    );
  });
}

// Sanity: lookup-by-id helper resolves the same entries.
test("#2911 getModelsByProviderId(github) reflects the targetFormat changes", () => {
  const models = getModelsByProviderId("github") as ModelEntry[];
  const opus48 = models.find((m) => m.id === "claude-opus-4.8");
  assert.ok(opus48, "claude-opus-4.8 resolvable via getModelsByProviderId");
  assert.equal(opus48.targetFormat, "claude");
});
