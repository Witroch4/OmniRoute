import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesFamilyGlob,
  matchesFamilyGlobAgainstFullId,
  pickNewestFamilyMember,
  resolveFamilyTargetModel,
} from "../../../src/lib/usage/modelFamilyGlob.ts";

test("a family glob matches current and future members", () => {
  for (const model of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-5"]) {
    assert.equal(matchesFamilyGlob(model, "claude-opus-*"), true, model);
  }
});

test("a family glob does not match a sibling family", () => {
  assert.equal(matchesFamilyGlob("claude-sonnet-5", "claude-opus-*"), false);
  assert.equal(matchesFamilyGlob("claude-haiku-4-5-20251001", "claude-opus-*"), false);
});

test("the provider prefix is stripped before matching", () => {
  assert.equal(matchesFamilyGlob("cc/claude-opus-4-8", "claude-opus-*"), true);
});

test("matching is case-insensitive", () => {
  assert.equal(matchesFamilyGlob("CLAUDE-OPUS-4-8", "claude-opus-*"), true);
});

test("a glob with no wildcard matches only that exact model", () => {
  assert.equal(matchesFamilyGlob("claude-sonnet-5", "claude-sonnet-5"), true);
  assert.equal(matchesFamilyGlob("claude-sonnet-4-6", "claude-sonnet-5"), false);
});

test("target resolution picks the registry's newest matching member", () => {
  assert.equal(resolveFamilyTargetModel("claude", "claude-sonnet-*"), "claude-sonnet-5");
});

test("overflow to a family goes to its NEWEST member (Fable -> Opus lands on Opus 5.5)", () => {
  assert.equal(resolveFamilyTargetModel("claude", "claude-opus-*"), "claude-opus-5-5");
});

test("newest wins by version, not by list order", () => {
  // The 2026-09-23 regression: Opus 5.5 listed AFTER Opus 5 and the overflow
  // kept landing on the older model because the first match won.
  const ids = ["claude-fable-5-1", "claude-opus-5", "claude-opus-5-5", "claude-opus-4-8"];
  assert.equal(pickNewestFamilyMember(ids, "claude-opus-*"), "claude-opus-5-5");
  assert.equal(pickNewestFamilyMember(["gpt-5.6-sol", "gpt-6-sol"], "gpt-*-sol"), "gpt-6-sol");
  assert.equal(
    pickNewestFamilyMember(["claude-opus-4-8", "claude-opus-4-10"], "claude-opus-*"),
    "claude-opus-4-10"
  );
});

test("same-version effort tiers keep the base id (registry order breaks ties)", () => {
  assert.equal(resolveFamilyTargetModel("codex", "gpt-5.6-terra*"), "gpt-5.6-terra");
  assert.equal(resolveFamilyTargetModel("codex", "gpt-6-astra*"), "gpt-6-astra");
});

test("a dated snapshot is not newer than the same version without a date", () => {
  const target = resolveFamilyTargetModel("claude", "claude-haiku-*");
  assert.ok(target && target.startsWith("claude-haiku-4-5"), String(target));
});

test("target resolution returns null when the glob matches nothing", () => {
  assert.equal(resolveFamilyTargetModel("claude", "claude-nonexistent-*"), null);
});

test("target resolution returns null for an unknown provider", () => {
  assert.equal(resolveFamilyTargetModel("not-a-provider", "claude-sonnet-*"), null);
});

// Final-review Finding 5: matchesFamilyGlobAgainstFullId mirrors the spend query's SQL
// GLOB (apiKeyUsageLimits.ts's getApiKeyFamilyRealSpendSince), which matches the FULL
// stored model id with no provider-prefix stripping — unlike matchesFamilyGlob above.
test("matchesFamilyGlobAgainstFullId does NOT strip the provider prefix, unlike matchesFamilyGlob", () => {
  assert.equal(matchesFamilyGlobAgainstFullId("cc/claude-opus-4-8", "claude-opus-*"), false);
  assert.equal(matchesFamilyGlob("cc/claude-opus-4-8", "claude-opus-*"), true);
});

test("matchesFamilyGlobAgainstFullId matches a slash-bearing id when the glob spans the prefix", () => {
  assert.equal(
    matchesFamilyGlobAgainstFullId("anthropic/claude-sonnet-4.6", "*claude-sonnet-*"),
    true
  );
});

test("matchesFamilyGlobAgainstFullId matches a model id with no slash exactly like matchesFamilyGlob", () => {
  for (const model of ["claude-opus-4-8", "claude-opus-5"]) {
    assert.equal(matchesFamilyGlobAgainstFullId(model, "claude-opus-*"), true, model);
    assert.equal(
      matchesFamilyGlobAgainstFullId(model, "claude-opus-*"),
      matchesFamilyGlob(model, "claude-opus-*"),
      model
    );
  }
});
