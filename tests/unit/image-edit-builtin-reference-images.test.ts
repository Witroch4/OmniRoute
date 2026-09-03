/**
 * tests/unit/image-edit-builtin-reference-images.test.ts
 *
 * `/v1/images/edits` used to reject EVERY built-in provider outright, so
 * image-to-image was reachable only through chatgpt-web (and only for images
 * OmniRoute had itself generated) or a custom OpenAI-compatible node. That was a
 * gap, not a limitation: Gemini's generateContent has always accepted image
 * parts, and the antigravity handler's own response parser already reads image
 * parts back out of the reply.
 *
 * These lock the behaviour that closes it, and the two invariants that keep it
 * honest: a provider that has NOT declared the capability is still refused, and
 * every reference the caller sent is forwarded (silently dropping extras would
 * return an image that ignored most of the input).
 */
import test from "node:test";
import assert from "node:assert/strict";

const registry = await import("../../open-sse/config/imageRegistry.ts");
const handlers = await import("../../open-sse/handlers/imageGeneration.ts");
const routeModel = await import("../../src/lib/images/imageRouteModel.ts");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAADUlEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==";

test("the antigravity image provider declares reference-image support", () => {
  const config = registry.getImageProvider("antigravity");
  assert.equal(config?.supportsImageEdit, true);
  assert.equal(config?.format, "gemini-image");
});

test("the capability is opt-in: providers that never declared it stay unsupported", async () => {
  // A provider WITHOUT the flag must still be refused — the fix must not have
  // turned "every built-in" from always-no into always-yes.
  const openaiish = registry.getImageProvider("hyperbolic");
  assert.ok(openaiish, "expected the hyperbolic provider to exist");
  assert.notEqual(openaiish?.supportsImageEdit, true);

  const result = await handlers.handleBuiltInImageEdit({
    provider: "hyperbolic",
    model: "some-model",
    providerConfig: openaiish,
    body: { prompt: "x" },
    referenceImages: [{ data: PNG_B64, mimeType: "image/png" }],
    credentials: {},
    log: null,
  });
  assert.ok(handlers.isBuiltInImageEditFailure(result), "expected a failure result");
  assert.equal(result.status, 400);
  assert.match(String(result.error), /not supported for built-in provider/i);
});

test("a declared provider whose format has no edit path fails loudly, not silently", async () => {
  // Registry mistake: flagged, but the format has no branch. It must NOT fall
  // through to a plain generation that quietly discards the references.
  const result = await handlers.handleBuiltInImageEdit({
    provider: "make-believe",
    model: "m",
    providerConfig: { id: "make-believe", format: "no-such-format", supportsImageEdit: true },
    body: { prompt: "x" },
    referenceImages: [{ data: PNG_B64, mimeType: "image/png" }],
    credentials: {},
    log: null,
  });
  assert.ok(handlers.isBuiltInImageEditFailure(result), "expected a failure result");
  assert.equal(result.status, 500, "a registry mistake is a server error, not a client one");
  assert.match(String(result.error), /has no edit path/i);
});

test("the JSON edit reader keeps EVERY image, not just the first", () => {
  const dataUrl = (mime: string) => `data:${mime};base64,${PNG_B64}`;
  const parsed = routeModel.extractImageEditInputFromJson({
    prompt: "combine",
    model: "antigravity/gemini-3.1-flash-image",
    images: [dataUrl("image/png"), { image_url: dataUrl("image/jpeg") }],
  });

  assert.equal(parsed.images.length, 2, "both references must survive");
  assert.equal(parsed.images[0].mime, "image/png");
  assert.equal(parsed.images[1].mime, "image/jpeg");
  // The single-image fields still mirror the first, because chatgpt-web and the
  // OpenAI-compatible forward can only carry one.
  assert.ok(parsed.imageBytes);
  assert.equal(parsed.imageMime, "image/png");
  assert.deepEqual(parsed.imageBytes, parsed.images[0].bytes);
});

test("an edit body with no resolvable image yields no references at all", () => {
  const parsed = routeModel.extractImageEditInputFromJson({
    prompt: "nothing here",
    images: ["not-a-data-url", { image_url: 42 }],
  });
  assert.deepEqual(parsed.images, []);
  assert.equal(parsed.imageBytes, null);
});

test("agy and antigravity resolve to the same image provider, so both accept edits", () => {
  const viaAlias = registry.parseImageModel("agy/gemini-3.1-flash-image");
  const viaCanonical = registry.parseImageModel("antigravity/gemini-3.1-flash-image");
  assert.equal(viaAlias.provider, viaCanonical.provider);
  assert.equal(registry.getImageProvider(viaAlias.provider)?.supportsImageEdit, true);
});
