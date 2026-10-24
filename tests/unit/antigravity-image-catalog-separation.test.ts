import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  isUserCallableAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { AGY_PUBLIC_MODELS, isUserCallableAgyModelId } from "../../open-sse/config/agyModels.ts";
import { getImageProvider } from "../../open-sse/config/imageRegistry.ts";

// Fork: the curated agy/antigravity catalogs keep publishing the image models (agy:
// `gemini-3.1-flash-image`; antigravity: also `gemini-3-pro-image-preview`) — the sync brief
// forbids dropping anything the fork publishes. The image registry serves them too.
test("Antigravity and AGY keep their published image models and the image registry serves them", () => {
  const chatModelIds = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));
  const agyChatModelIds = new Set(AGY_PUBLIC_MODELS.map((model) => model.id));

  assert.equal(chatModelIds.has("gemini-3.1-flash-image"), true);
  assert.equal(chatModelIds.has("gemini-3-pro-image-preview"), true);
  assert.equal(isUserCallableAntigravityModelId("gemini-3.1-flash-image"), true);
  assert.equal(agyChatModelIds.has("gemini-3.1-flash-image"), true);
  assert.equal(isUserCallableAgyModelId("gemini-3.1-flash-image"), true);

  const imageProvider = getImageProvider("antigravity");
  assert.ok(imageProvider);
  assert.equal(
    imageProvider.models.some((model) => model.id === "gemini-3.1-flash-image"),
    true
  );
});
