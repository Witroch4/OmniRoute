import assert from "node:assert/strict";
import test from "node:test";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { isRetiredGitHubCopilotModelId } from "../../open-sse/config/providers/registry/github/retiredModels.ts";
import {
  GITHUB_COPILOT_STATIC_FALLBACK_MODELS,
  fetchGitHubCopilotModels,
  parseGitHubCopilotModels,
} from "../../open-sse/services/githubCopilotModels.ts";

// GitHub's announced retirements (2026-09-01 and the 2026-10-02 advance removals)
// plus the upstream operator removals that the fork does NOT publish either.
const RETIRED = [
  "gemini-3.1-pro-preview",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-sonnet-4.5",
  "oswe-vscode-prime",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "kimi-k2.7-code",
  "claude-opus-4.7",
  "mai-code-1-flash-picker",
  "gpt-5.4-nano",
  "gpt-4",
  "gpt-4o",
];

// Fork: upstream retires these "by operator choice" (not a GitHub retirement); the
// fork's operator keeps them — they are on this account's Copilot picker.
const FORK_KEPT = [
  "claude-sonnet-4.6",
  "claude-fable-5",
  "gemini-3.7-flash",
  "grok-4.5",
  "mai-code-1-flash",
  "gpt-5-mini",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-4-0125-preview",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini",
];

test("September retirements and October advance removals stay out of Copilot catalogs", () => {
  const catalog = getModelsByProviderId("github");
  for (const id of RETIRED) {
    assert.equal(isRetiredGitHubCopilotModelId("github", id), true, id);
    assert.equal(isRetiredGitHubCopilotModelId(" GH ", ` ${id.toUpperCase()} `), true, id);
    assert.equal(isRetiredGitHubCopilotModelId("openai", id), false, id);
    assert.ok(!catalog.some((model) => model.id === id), id);
    assert.ok(!new Set<string>(GITHUB_COPILOT_STATIC_FALLBACK_MODELS).has(id), id);
  }
});

test("fork: upstream's operator-choice removals stay published on the fork", () => {
  const catalog = new Set(getModelsByProviderId("github").map((model) => model.id));
  const fallback = new Set<string>(GITHUB_COPILOT_STATIC_FALLBACK_MODELS);
  for (const id of FORK_KEPT) {
    assert.equal(isRetiredGitHubCopilotModelId("github", id), false, id);
    assert.ok(catalog.has(id), id);
    assert.ok(fallback.has(id), id);
  }
});

test("Copilot live and fallback refreshes cannot restore announced retirements", async () => {
  const ids = [...RETIRED, "gpt-6-astra", "gemini-3.8-flash", "kimi-k3"];
  const data = ids.map((id) => ({
    id,
    capabilities: { type: "chat" },
    policy: { state: "enabled" },
    model_picker_enabled: true,
  }));
  assert.deepEqual(
    parseGitHubCopilotModels({ data }).map((model) => model.id),
    ["gpt-6-astra", "gemini-3.8-flash", "kimi-k3"]
  );
  // Fork: the offline fallback only keeps the fork account's picker (no gpt-6-astra).
  const fallback = await fetchGitHubCopilotModels({ token: "", fallbackModels: data });
  assert.deepEqual(
    fallback.models.map((model) => model.id),
    ["gemini-3.8-flash", "kimi-k3"]
  );
});

test("Selected replacements remain eligible", () => {
  // Fork: claude-fable-5.1 is policy-disabled on this account; Sonnet 5.5 replaces it here.
  for (const id of ["claude-sonnet-5", "gemini-3.8-flash", "grok-4.6", "claude-sonnet-5.5"]) {
    assert.equal(isRetiredGitHubCopilotModelId("github", id), false, id);
    assert.ok(new Set<string>(GITHUB_COPILOT_STATIC_FALLBACK_MODELS).has(id), id);
  }
});

test("Copilot static catalog and fallback contain exactly the fork account's picker", () => {
  const expected = [
    "claude-fable-5",
    "claude-opus-4.8-fast",
    "claude-opus-4.8",
    "claude-sonnet-4.6",
    "claude-sonnet-5.5",
    "claude-sonnet-5",
    "claude-haiku-5.5",
    "claude-haiku-4.5",
    "gpt-5.5",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gpt-6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "grok-4.7",
    "grok-4.6",
    "grok-4.5",
    "mai-code-1.1-flash",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4o-2024-11-20",
    "gpt-4o-mini",
    "gpt-4-0125-preview",
    "kimi-k3",
    "mai-code-1-flash",
    // Copilot-side model selection (Copilot Free); resolved per request via /auto.
    "auto",
  ];
  assert.deepEqual(
    getModelsByProviderId("github").map((model) => model.id),
    expected
  );
  assert.deepEqual(GITHUB_COPILOT_STATIC_FALLBACK_MODELS, expected);
});
