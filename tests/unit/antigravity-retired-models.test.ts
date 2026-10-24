/**
 * Retired Antigravity models are refused by name, scoped to the (provider, id) pair.
 *
 * Google retired Gemini 3.5/3.6/3.7 Flash and Gemini 3.1 Pro on the Antigravity backend
 * (2026-10-23). `agy` and `antigravity` both set `passthroughModels`, so dropping an id from
 * the catalog does not stop a client from asking for it; without a refusal 3.5 comes back as
 * an HTTP 200 "no longer available" notice and the others as upstream 404s that arm the
 * per-model lockout. These tests pin the lookup the chat pipeline uses to refuse them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  findRetiredAntigravityModel,
  retiredAntigravityModelMessage,
} from "../../open-sse/config/antigravityRetiredModels.ts";
import { AGY_PUBLIC_MODELS } from "../../open-sse/config/agyModels.ts";
import { ANTIGRAVITY_PUBLIC_MODELS } from "../../open-sse/config/antigravityModelAliases.ts";

const TIERS = ["low", "medium", "high"] as const;
const PROVIDERS = ["agy", "antigravity", "ag"] as const;

test("every Gemini 3.5/3.6/3.7 Flash tier is retired on agy, antigravity and the ag alias", () => {
  for (const provider of PROVIDERS) {
    for (const version of ["3.5", "3.6", "3.7"]) {
      for (const tier of TIERS) {
        const retired = findRetiredAntigravityModel(provider, `gemini-${version}-flash-${tier}`);
        assert.ok(retired, `${provider}/gemini-${version}-flash-${tier} must be retired`);
        assert.equal(retired.family, `Gemini ${version} Flash`);
        // The successor keeps the tier the caller asked for.
        assert.equal(retired.replacement, `gemini-3.8-flash-${tier}`);
      }
    }
  }
});

test("legacy Gemini 3.5 ids and every Gemini 3.1 Pro id are retired too", () => {
  assert.equal(
    findRetiredAntigravityModel("agy", "gemini-3.5-flash-preview")?.replacement,
    "gemini-3.8-flash-high"
  );
  assert.equal(
    findRetiredAntigravityModel("antigravity", "gemini-3.5-flash-extra-low")?.replacement,
    "gemini-3.8-flash-low"
  );
  assert.equal(
    findRetiredAntigravityModel("antigravity", "gemini-3-flash-agent")?.replacement,
    "gemini-3.8-flash-high"
  );
  for (const id of [
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3.1-pro",
    "gemini-pro-agent",
    "gemini-3-pro-preview",
    "gemini-3-pro-high",
    "gemini-3-pro-low",
  ]) {
    const retired = findRetiredAntigravityModel("agy", id);
    assert.ok(retired, `${id} must be retired`);
    assert.equal(retired.family, "Gemini 3.1 Pro");
  }
});

test("live models are never refused", () => {
  for (const provider of PROVIDERS) {
    for (const id of [
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
      "gemini-3.1-flash-lite",
      "gemini-3.1-flash-image",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-thinking",
      "claude-opus-5-5-high",
      "claude-sonnet-5-5-low",
      "gpt-oss-120b-medium",
    ]) {
      assert.equal(findRetiredAntigravityModel(provider, id), null, `${provider}/${id}`);
    }
  }
});

test("the same ids stay usable on providers where they are alive", () => {
  // GitHub Copilot and the Gemini API still serve Gemini 3.x; only Antigravity retired them.
  for (const provider of ["github", "gh", "gemini", "openai", "claude", "cc", "codex"]) {
    assert.equal(findRetiredAntigravityModel(provider, "gemini-3.7-flash-high"), null);
    assert.equal(findRetiredAntigravityModel(provider, "gemini-3.1-pro-high"), null);
    assert.equal(findRetiredAntigravityModel(provider, "gemini-3.5-flash-low"), null);
  }
});

test("matching tolerates case and surrounding whitespace, and ignores non-strings", () => {
  assert.ok(findRetiredAntigravityModel(" AGY ", "  Gemini-3.5-Flash-Low "));
  assert.equal(findRetiredAntigravityModel(undefined, "gemini-3.5-flash-low"), null);
  assert.equal(findRetiredAntigravityModel("agy", undefined), null);
  assert.equal(findRetiredAntigravityModel("agy", ""), null);
  assert.equal(findRetiredAntigravityModel(null, null), null);
  assert.equal(findRetiredAntigravityModel("agy", 42), null);
});

test("no retired id is still published in either catalog", () => {
  const published = new Set([
    ...AGY_PUBLIC_MODELS.map((model) => model.id),
    ...ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id),
  ]);
  for (const id of published) {
    assert.equal(
      findRetiredAntigravityModel("agy", id),
      null,
      `${id} is published but also listed as retired`
    );
  }
});

test("every suggested replacement is a model the catalog actually publishes", () => {
  const agyIds = new Set(AGY_PUBLIC_MODELS.map((model) => model.id));
  const suggested = new Set<string>();
  for (const version of ["3.5", "3.6", "3.7"]) {
    for (const tier of TIERS) {
      const retired = findRetiredAntigravityModel("agy", `gemini-${version}-flash-${tier}`);
      for (const id of (retired?.replacement ?? "").split(" or ")) suggested.add(id);
    }
  }
  for (const id of (
    findRetiredAntigravityModel("agy", "gemini-3.1-pro-high")?.replacement ?? ""
  ).split(" or ")) {
    suggested.add(id);
  }
  assert.ok(suggested.size > 0);
  for (const id of suggested) {
    assert.ok(agyIds.has(id), `the error would send callers to ${id}, which agy does not publish`);
  }
});

test("the refusal message names the model, the reason and the successor", () => {
  const retired = findRetiredAntigravityModel("agy", "gemini-3.5-flash-low");
  assert.ok(retired);
  assert.equal(
    retiredAntigravityModelMessage("agy", "gemini-3.5-flash-low", retired),
    'Model "agy/gemini-3.5-flash-low" is no longer available: Google retired Gemini 3.5 Flash ' +
      "on the Antigravity backend. Use gemini-3.8-flash-low instead."
  );
});
