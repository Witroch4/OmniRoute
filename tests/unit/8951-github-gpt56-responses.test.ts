import assert from "node:assert/strict";
import test from "node:test";

import { GithubExecutor } from "../../open-sse/executors/github.ts";

// Fork: gpt-5.6-sol is policy-disabled on the fork's Copilot account and is not in its static
// gh catalog; served through live discovery it carries its Responses-only target format on
// the credentials (chatCore/executionCredentials.ts), which is what this resolves with.
const DISCOVERED_RESPONSES = { providerSpecificData: { targetFormat: "openai-responses" } };

test("#8951 GitHub GPT-5.6 models must use the Responses endpoint", () => {
  const executor = new GithubExecutor();
  const urls = Object.fromEntries(
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((model) => [
      model,
      executor.buildUrl(model, false, 0, model === "gpt-5.6-sol" ? DISCOVERED_RESPONSES : null),
    ])
  );
  assert.deepEqual(urls, {
    "gpt-5.6-sol": "https://api.githubcopilot.com/responses",
    "gpt-5.6-terra": "https://api.githubcopilot.com/responses",
    "gpt-5.6-luna": "https://api.githubcopilot.com/responses",
  });
});
