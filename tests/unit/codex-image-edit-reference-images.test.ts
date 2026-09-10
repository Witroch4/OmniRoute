/**
 * tests/unit/codex-image-edit-reference-images.test.ts
 *
 * `/v1/images/edits` refused the `codex` provider, which is the only route on
 * this deployment that reaches gpt-image-2 (the hosted `image_generation` tool
 * under ChatGPT OAuth). That made image-to-image impossible on the best image
 * model available here.
 *
 * It was a gap, not a limitation. The very same upstream endpoint already reads
 * `input_image` parts on the chat path — verified live: an 8x8 red PNG sent to
 * cx/gpt-5.6-sol comes back described as "Vermelho". The handler simply built
 * its `input` from the prompt alone and never carried the references.
 *
 * These lock the fix plus the invariants that keep it honest: references are
 * forwarded in the shape the Responses translator emits, every one of them
 * arrives (not just the first), they precede the directive text, the hosted tool
 * is still requested, and text-only generation is unchanged.
 *
 * NOT covered here: that the reference base64 stays out of the call log. That
 * would need to intercept saveCallLog, and this repo deliberately avoids
 * mock.module (it needs experimental flags in ESM) — see the note in
 * tests/unit/dns-config-generic.test.ts. The separate `logRequestBody` in the
 * handler is what enforces it.
 */
import test from "node:test";
import assert from "node:assert/strict";

const registry = await import("../../open-sse/config/imageRegistry.ts");
const handlers = await import("../../open-sse/handlers/imageGeneration.ts");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAADUlEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==";
const OUT_B64 = "T1VUUFVUX0lNQUdF";

function sseWithImage(): string {
  return [
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: OUT_B64, revised_prompt: "revised" },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n");
}

/** Runs `fn` with a stubbed fetch, capturing every upstream body it received. */
async function withCapturedFetch(
  fn: (bodies: Array<Record<string, unknown>>) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return {
      ok: true,
      status: 200,
      text: async () => sseWithImage(),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn(bodies);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function codexEdit(referenceImages: Array<{ data: string; mimeType: string }>) {
  return handlers.handleBuiltInImageEdit({
    provider: "codex",
    model: "gpt-5.6-sol",
    providerConfig: registry.getImageProvider("codex"),
    body: { model: "codex/gpt-5.6-sol", prompt: "make it blue", response_format: "b64_json" },
    referenceImages,
    credentials: { accessToken: "test-token" },
    log: null,
  });
}

test("the codex image provider declares reference-image support", () => {
  const config = registry.getImageProvider("codex");
  assert.equal(config?.supportsImageEdit, true);
  assert.equal(config?.format, "codex-responses");
});

test("an edit through codex forwards every reference as an input_image part", async () => {
  await withCapturedFetch(async (bodies) => {
    const result = await codexEdit([
      { data: PNG_B64, mimeType: "image/png" },
      { data: PNG_B64, mimeType: "image/jpeg" },
    ]);

    assert.equal(handlers.isBuiltInImageEditFailure(result), false);
    assert.equal(bodies.length, 1);

    const content = (bodies[0].input as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    const images = content.filter((part) => part.type === "input_image");
    assert.equal(images.length, 2, "both references must reach the upstream, not just the first");
    assert.equal(images[0].image_url, `data:image/png;base64,${PNG_B64}`);
    assert.equal(
      images[1].image_url,
      `data:image/jpeg;base64,${PNG_B64}`,
      "the caller's mime type must be preserved, not forced to png"
    );
  });
});

test("references precede the directive text", async () => {
  await withCapturedFetch(async (bodies) => {
    await codexEdit([{ data: PNG_B64, mimeType: "image/png" }]);

    const content = (bodies[0].input as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    // Reversed, the model describes the references instead of generating from
    // them — the same ordering rule the Gemini image path documents.
    assert.equal(content[0].type, "input_image");
    assert.equal(content[content.length - 1].type, "input_text");
    assert.equal(content[content.length - 1].text, "make it blue");
  });
});

test("the hosted image_generation tool is still requested on the edit path", async () => {
  await withCapturedFetch(async (bodies) => {
    await codexEdit([{ data: PNG_B64, mimeType: "image/png" }]);

    const tools = bodies[0].tools as Array<{ type?: string }>;
    assert.equal(
      tools.some((tool) => tool.type === "image_generation"),
      true
    );
  });
});

test("plain generation still sends no image part when there is no reference", async () => {
  await withCapturedFetch(async (bodies) => {
    // The edit branch and the generation branch share one handler; adding
    // references must not make text-only generation start carrying an empty or
    // malformed image part.
    const result = await handlers.handleImageGeneration({
      body: { model: "cx/gpt-5.6-sol", prompt: "a plain image", response_format: "b64_json" },
      credentials: { accessToken: "test-token" },
      log: null,
    });

    assert.equal(result.success, true);
    const content = (bodies[0].input as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "input_text");
  });
});
