/**
 * Curated GitHub Copilot GPT-4-family registry coverage.
 *
 * The final Copilot allowlist keeps `gpt-4-0125-preview` but intentionally drops
 * the older bare `gpt-4` alias. GPT-4 Turbo is a chat/completions model — it
 * must NOT use `openai-responses`.
 *
 * Fork: upstream 3.8.53 drops `gpt-4-0125-preview` from its curated Copilot catalog "by
 * operator choice"; the fork keeps it (it is on this account's Copilot picker).
 * The bare `gpt-4` alias stays retired on both sides.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { getModelsByProviderId, getProviderModel, isValidModel } =
  await import("../../open-sse/config/providerModels.ts");

type ModelEntry = { id: string; name?: string; targetFormat?: string; [k: string]: unknown };

function githubModel(id: string): ModelEntry | undefined {
  const provider = (REGISTRY as Record<string, { models?: ModelEntry[] }>)["github"];
  return provider?.models?.find((m) => m.id === id);
}

test("github/gpt-4-0125-preview is registered under the gh provider", () => {
  const model = githubModel("gpt-4-0125-preview");
  assert.ok(model, "gpt-4-0125-preview must be registered under the github (gh) provider");
  assert.equal(typeof model?.name, "string");
});

test("github/gpt-4-0125-preview routes via chat/completions (no openai-responses)", () => {
  const model = githubModel("gpt-4-0125-preview");
  assert.ok(model);
  assert.notEqual(
    model.targetFormat,
    "openai-responses",
    "GPT-4 Turbo on GitHub Copilot is a chat/completions model — Responses API would reject it"
  );
});

test("getModelsByProviderId(github) exposes gpt-4-0125-preview", () => {
  const models = getModelsByProviderId("github") as ModelEntry[];
  const gpt4 = models.find((m) => m.id === "gpt-4-0125-preview");
  assert.ok(gpt4, "gpt-4-0125-preview resolvable via getModelsByProviderId(github)");
});

test("gpt-4-0125-preview resolves through both the gh alias and the github id", () => {
  // getProviderModel keys on the public alias; isValidModel mirrors it.
  assert.ok(
    getProviderModel("gh", "gpt-4-0125-preview"),
    "getProviderModel('gh','gpt-4-0125-preview') must resolve"
  );
  assert.equal(
    isValidModel("gh", "gpt-4-0125-preview"),
    true,
    "isValidModel('gh','gpt-4-0125-preview') must be true"
  );
  // Raw provider id resolves to the same entry via the alias map.
  const viaId = getModelsByProviderId("github").find((m) => m.id === "gpt-4-0125-preview");
  assert.ok(viaId, "gpt-4-0125-preview resolvable via the raw 'github' provider id");
  // 3.8.53: isValidModel() now also accepts any id another provider publishes (global
  // lookup), so the curated-list check reads the gh catalog itself.
  assert.equal(
    getModelsByProviderId("github").some((m) => m.id === "gpt-4"),
    false,
    "bare gpt-4 is not in the curated list"
  );
});

test("bare gpt-4 stays out of live discovery (retired); gpt-4-0125-preview is kept", async () => {
  const { parseGitHubCopilotModels } = await import("../../open-sse/services/githubCopilotModels.ts");
  assert.deepEqual(
    parseGitHubCopilotModels({
      data: ["gpt-4", "gpt-4-0125-preview"].map((id) => ({ id, capabilities: { type: "chat" } })),
    }).map((model) => model.id),
    ["gpt-4-0125-preview"]
  );
});
