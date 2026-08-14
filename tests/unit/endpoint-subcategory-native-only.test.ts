import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isEndpointAllowed,
  resolveEndpointSelectors,
} from "../../src/shared/constants/endpointCategories.ts";

/**
 * The `chat` category bundles four wire protocols onto one permission, so a key meant
 * to serve only Claude Code (`/v1/messages`, Anthropic Messages format) could also be
 * driven by any OpenAI-format client through `/v1/chat/completions`. On a connection
 * backed by a Claude subscription OAuth credential that is the whole risk: a
 * third-party agent riding a credential scoped to Claude Code.
 *
 * `chat:messages` narrows the same category to the Anthropic-native path only.
 * Selecting the parent `chat` must keep behaving exactly as before.
 */
describe("endpoint subcategories — Anthropic-native-only restriction", () => {
  const NATIVE = "/v1/messages";
  const OPENAI_COMPAT = ["/v1/chat/completions", "/v1/completions"];
  const RESPONSES = "/v1/responses";

  test("resolves both the category and the narrow selector", () => {
    assert.deepEqual(resolveEndpointSelectors(NATIVE), {
      categoryId: "chat",
      subcategoryId: "chat:messages",
    });
    assert.deepEqual(resolveEndpointSelectors("/v1/chat/completions"), {
      categoryId: "chat",
      subcategoryId: "chat:completions",
    });
    assert.deepEqual(resolveEndpointSelectors(RESPONSES), {
      categoryId: "chat",
      subcategoryId: "chat:responses",
    });
  });

  test('stored ["chat"] keeps allowing every chat path (backward compatible)', () => {
    for (const path of [NATIVE, ...OPENAI_COMPAT, RESPONSES]) {
      assert.equal(isEndpointAllowed(path, ["chat"]).allowed, true, path);
    }
  });

  test('["chat:messages"] allows Anthropic-native and denies OpenAI-format', () => {
    assert.equal(isEndpointAllowed(NATIVE, ["chat:messages"]).allowed, true);

    for (const path of [...OPENAI_COMPAT, RESPONSES]) {
      const verdict = isEndpointAllowed(path, ["chat:messages"]);
      assert.equal(verdict.allowed, false, path);
      assert.equal(verdict.allowed === false && verdict.deniedSelector.startsWith("chat:"), true);
    }
  });

  test("the unversioned spelling cannot bypass the narrow selector", () => {
    // Same bypass class as the /v1-prefix fix: these rewrite onto the /v1 handlers.
    for (const path of ["/chat/completions", "/completions", "/responses"]) {
      assert.equal(isEndpointAllowed(path, ["chat:messages"]).allowed, false, path);
    }
    assert.equal(isEndpointAllowed("/messages", ["chat:messages"]).allowed, true);
    assert.equal(isEndpointAllowed("/v1/v1/chat/completions", ["chat:messages"]).allowed, false);
    assert.equal(isEndpointAllowed("/api/v1/chat/completions", ["chat:messages"]).allowed, false);
  });

  test("the /codex alias resolves to responses and is denied", () => {
    assert.equal(isEndpointAllowed("/codex/anything", ["chat:messages"]).allowed, false);
  });

  test("subcategories can be combined without granting the whole category", () => {
    const allowed = ["chat:messages", "chat:completions"];
    assert.equal(isEndpointAllowed(NATIVE, allowed).allowed, true);
    assert.equal(isEndpointAllowed("/v1/chat/completions", allowed).allowed, true);
    assert.equal(isEndpointAllowed(RESPONSES, allowed).allowed, false);
  });

  test("empty restriction and off-table paths stay unrestricted", () => {
    assert.equal(isEndpointAllowed("/v1/chat/completions", []).allowed, true);
    assert.equal(isEndpointAllowed("/v1/chat/completions", undefined).allowed, true);
    // Management routes carry no category and must not be caught by the restriction.
    assert.equal(isEndpointAllowed("/api/keys", ["chat:messages"]).allowed, true);
  });

  test("a narrow chat selector does not leak into other categories", () => {
    assert.equal(isEndpointAllowed("/v1/embeddings", ["chat:messages"]).allowed, false);
    assert.equal(isEndpointAllowed("/v1/models", ["chat:messages", "models"]).allowed, true);
  });
});
