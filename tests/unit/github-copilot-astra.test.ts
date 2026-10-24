import assert from "node:assert/strict";
import test from "node:test";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { GithubExecutor } from "../../open-sse/executors/github.ts";
import {
  fetchGitHubCopilotModels,
  parseGitHubCopilotModels,
} from "../../open-sse/services/githubCopilotModels.ts";

// Fork: gpt-6-astra is policy-disabled on the fork's Copilot account (2026-10-12:
// `400 The requested model is not supported`), so it stays OUT of the static gh
// catalog and the offline fallback. Upstream's curated catalog lists it first. What
// still holds here: live discovery keeps it when the account is entitled, routes it
// Responses-only, and the executor honours that resolved target format.

test("Copilot static catalog leaves Astra out on the fork (policy-disabled on this account)", () => {
  const ids = getModelsByProviderId("github").map((entry) => entry.id);
  assert.equal(ids.includes("gpt-6-astra"), false);
});

test("Copilot Astra routes streaming and non-streaming calls through Responses once resolved", () => {
  const executor = new GithubExecutor();
  const credentials = { providerSpecificData: { targetFormat: "openai-responses" } };
  for (const stream of [false, true]) {
    assert.equal(
      executor.buildUrl("gpt-6-astra", stream, 0, credentials),
      "https://api.githubcopilot.com/responses"
    );
  }
});

test("Copilot Astra: live discovery respects policy, the offline fallback never invents it", async () => {
  const fallback = await fetchGitHubCopilotModels({
    token: "",
    fallbackModels: [...getModelsByProviderId("github"), { id: "gpt-6-astra" }],
  });
  assert.equal(fallback.source, "fallback");
  assert.ok(!fallback.models.some((model) => model.id === "gpt-6-astra"));

  const model = {
    id: "gpt-6-astra",
    capabilities: { type: "chat" },
    supported_endpoints: ["/responses", "ws:/responses"],
    policy: { state: "enabled" },
    model_picker_enabled: true,
  };
  const [discovered] = parseGitHubCopilotModels({ data: [model] });
  assert.equal(discovered.id, model.id);
  assert.equal(discovered.targetFormat, "openai-responses");
  assert.deepEqual(
    parseGitHubCopilotModels({ data: [{ ...model, policy: { state: "disabled" } }] }),
    []
  );
  assert.deepEqual(
    parseGitHubCopilotModels({ data: [{ ...model, model_picker_enabled: false }] }),
    []
  );
});
