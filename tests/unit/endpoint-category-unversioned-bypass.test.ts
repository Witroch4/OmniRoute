import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveEndpointCategory } from "../../src/shared/constants/endpointCategories.ts";

/**
 * An API key restricted to specific endpoint categories could bypass the restriction
 * entirely by dropping the `/v1` prefix: `next.config.mjs` rewrites `/chat/completions`
 * onto `/api/v1/chat/completions`, but the handler observes the ORIGINAL pathname, and
 * `resolveEndpointCategory` only matched `/v1/...` prefixes. The unversioned form
 * resolved to `null`, and `apiKeyPolicy`'s check (`if (category && !allowed.includes)`)
 * skips on a null category — so the request went through unrestricted.
 *
 * Real production traffic already used the unversioned spelling, so this was reachable,
 * not theoretical.
 */
describe("endpoint category — unversioned bypass", () => {
  test("versioned inference paths resolve to chat", () => {
    for (const path of [
      "/v1/chat/completions",
      "/v1/completions",
      "/v1/messages",
      "/v1/responses",
    ]) {
      assert.equal(resolveEndpointCategory(path), "chat", path);
    }
  });

  test("unversioned aliases resolve to the SAME category as their /v1 twin", () => {
    assert.equal(resolveEndpointCategory("/chat/completions"), "chat");
    assert.equal(resolveEndpointCategory("/completions"), "chat");
    assert.equal(resolveEndpointCategory("/messages"), "chat");
    assert.equal(resolveEndpointCategory("/responses"), "chat");
    assert.equal(resolveEndpointCategory("/responses/abc"), "chat");
    assert.equal(resolveEndpointCategory("/models"), "models");
  });

  test("/codex/* rewrites onto /v1/responses and resolves to chat", () => {
    assert.equal(resolveEndpointCategory("/codex"), "chat");
    assert.equal(resolveEndpointCategory("/codex/anything"), "chat");
  });

  test("duplicated /v1/v1 alias collapses", () => {
    assert.equal(resolveEndpointCategory("/v1/v1/chat/completions"), "chat");
    assert.equal(resolveEndpointCategory("/v1/v1/embeddings"), "embeddings");
  });

  test("rewrite destination (/api/v1/...) resolves like the source", () => {
    assert.equal(resolveEndpointCategory("/api/v1/chat/completions"), "chat");
    assert.equal(resolveEndpointCategory("/api/v1/embeddings"), "embeddings");
  });

  test("other categories keep resolving in both spellings", () => {
    for (const [versioned, unversioned, expected] of [
      ["/v1/embeddings", "/embeddings", "embeddings"],
      ["/v1/images/generations", "/images/generations", "images"],
      ["/v1/audio/speech", "/audio/speech", "audio"],
      ["/v1/files", "/files", "files"],
      ["/v1/batches", "/batches", "batches"],
    ] as const) {
      assert.equal(resolveEndpointCategory(versioned), expected, versioned);
      assert.equal(resolveEndpointCategory(unversioned), expected, unversioned);
    }
  });

  test("management and unknown routes still resolve to null (must stay unrestricted)", () => {
    for (const path of [
      "/dashboard",
      "/api/keys",
      "/api/providers/abc/models",
      "/health",
      "/login",
      "/",
    ]) {
      assert.equal(resolveEndpointCategory(path), null, path);
    }
  });
});
