import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IMAGE_PROVIDERS, parseImageModel } from "../../open-sse/config/imageRegistry.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";

// The `/v1/models` chat catalog and the image endpoint keep SEPARATE registries.
// That is fine until they disagree about a provider's NAME: the chat catalog then
// publishes an id the image endpoint refuses, and every consumer that mirrors
// `/v1/models` (the platform's LiteLLM seed included) asks for exactly what we
// advertised and gets `400 Invalid image model`. That is a contract break, not a
// missing capability — the model answers fine under the other name.
//
// Measured 2026-09-02: `antigravity/gemini-3.1-flash-image` returned a real 993 KB
// JPEG while `agy/gemini-3.1-flash-image` — the id `/v1/models` actually lists —
// was rejected. `agy` and `antigravity` are two catalog identities for one upstream
// (same executor, translator and credential; `agy` only ships its own chat catalog),
// so the image endpoint must accept both.
describe("image endpoint accepts the ids the chat catalog publishes", () => {
  it("resolves agy/ to the antigravity image provider", () => {
    const parsed = parseImageModel("agy/gemini-3.1-flash-image");
    assert.equal(parsed.provider, "antigravity");
    assert.equal(parsed.model, "gemini-3.1-flash-image");
  });

  it("still resolves the canonical antigravity/ id", () => {
    const parsed = parseImageModel("antigravity/gemini-3.1-flash-image");
    assert.equal(parsed.provider, "antigravity");
    assert.equal(parsed.model, "gemini-3.1-flash-image");
  });

  // The invariant, not just the instance: a provider that exists in BOTH registries
  // must be reachable on the image endpoint under every name the chat registry
  // publishes for it. Without this, the next duplicated identity drifts silently
  // exactly the way this one did.
  it("every shared provider is reachable under all of its chat-registry names", () => {
    const broken: string[] = [];
    for (const [imageProviderId, imageConfig] of Object.entries(IMAGE_PROVIDERS)) {
      const chatEntry = getRegistryEntry(imageProviderId);
      const names = new Set<string>([imageProviderId]);
      if (imageConfig.alias) names.add(imageConfig.alias);
      if (chatEntry?.alias) names.add(chatEntry.alias);

      for (const model of imageConfig.models) {
        for (const name of names) {
          // The invariant is ACCEPTANCE, not identity: some ids legitimately
          // resolve to another provider (an alias entry pointing at whoever
          // actually serves the model). Refusing the id outright is the bug.
          const parsed = parseImageModel(`${name}/${model.id}`);
          if (!parsed.provider) {
            broken.push(`${name}/${model.id}`);
          }
        }
      }
    }
    assert.deepEqual(broken, [], `image ids the endpoint refuses: ${broken.join("; ")}`);
  });
});
