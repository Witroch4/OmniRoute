import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesFamilyGlob,
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

test("target resolution returns null when the glob matches nothing", () => {
  assert.equal(resolveFamilyTargetModel("claude", "claude-nonexistent-*"), null);
});

test("target resolution returns null for an unknown provider", () => {
  assert.equal(resolveFamilyTargetModel("not-a-provider", "claude-sonnet-*"), null);
});
