/**
 * Curated GitHub Copilot GPT-4o registry coverage.
 *
 * The final Copilot allowlist keeps `gpt-4o-2024-11-20` but intentionally drops
 * the older bare `gpt-4o` alias. GPT-4o is a chat/completions model — it must
 * NOT use `openai-responses`.
 *
 * Fork: upstream 3.8.53 drops `gpt-4o-2024-11-20` from its curated Copilot catalog "by
 * operator choice"; the fork keeps it (it is on this account's Copilot picker).
 * The bare `gpt-4o` alias stays retired on both sides.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { getModelsByProviderId } = await import("../../open-sse/config/providerModels.ts");

type ModelEntry = { id: string; name?: string; targetFormat?: string; [k: string]: unknown };

function githubModel(id: string): ModelEntry | undefined {
  const provider = (REGISTRY as Record<string, { models?: ModelEntry[] }>)["github"];
  return provider?.models?.find((m) => m.id === id);
}

test("github/gpt-4o-2024-11-20 is registered under the gh provider", () => {
  const model = githubModel("gpt-4o-2024-11-20");
  assert.ok(model, "gpt-4o-2024-11-20 must be registered under the github (gh) provider");
  assert.equal(typeof model?.name, "string");
});

test("github/gpt-4o-2024-11-20 routes via chat/completions (no openai-responses)", () => {
  const model = githubModel("gpt-4o-2024-11-20");
  assert.ok(model);
  assert.notEqual(
    model.targetFormat,
    "openai-responses",
    "GPT-4o on GitHub Copilot is a chat/completions model — Responses API would reject it"
  );
});

test("getModelsByProviderId(github) exposes gpt-4o-2024-11-20", () => {
  const models = getModelsByProviderId("github") as ModelEntry[];
  const gpt4o = models.find((m) => m.id === "gpt-4o-2024-11-20");
  assert.ok(gpt4o, "gpt-4o-2024-11-20 resolvable via getModelsByProviderId(github)");
  assert.equal(
    models.some((m) => m.id === "gpt-4o"),
    false,
    "bare gpt-4o is not in the curated list"
  );
});

test("bare gpt-4o stays out of live discovery (retired); gpt-4o-2024-11-20 is kept", async () => {
  const { parseGitHubCopilotModels } = await import("../../open-sse/services/githubCopilotModels.ts");
  assert.deepEqual(
    parseGitHubCopilotModels({
      data: ["gpt-4o", "gpt-4o-2024-11-20"].map((id) => ({ id, capabilities: { type: "chat" } })),
    }).map((model) => model.id),
    ["gpt-4o-2024-11-20"]
  );
});
