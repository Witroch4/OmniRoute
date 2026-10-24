/**
 * #3696 — antigravity/agy tiered Gemini ids (`-high` / `-low`) were being collapsed to a bare
 * upstream id, losing the tier distinction.
 *
 * Wire evidence (captured by maintainer via `agy --model gemini-3.1-pro-high --log-file`):
 *   - `gemini-3.1-pro-high` sent literally to `/v1internal:streamGenerateContent` → 200 OK
 *   - `gemini-3.1-pro-low`  sent literally → 200 OK
 *
 * CONCLUSION: the upstream ACCEPTS the suffixed ids directly. The old assumption in #3229
 * ("upstream rejects the suffix for gemini-3.x") was refuted by this wire capture.
 * The collapse aliases must be removed so the tier-specific ids reach the upstream.
 *
 * 2026-10-23: Gemini 3.1 Pro was retired by Google and left the catalog, so the invariant is
 * now exercised on the LIVE tiered ids — Gemini 3.8 Flash (`-high` / `-medium` / `-low`),
 * which has no bare id and therefore must never be aliased or collapsed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  resolveAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";

test("(#3696) resolveAntigravityModelId passes gemini-3.8-flash-high through unchanged", () => {
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
});

test("(#3696) resolveAntigravityModelId passes gemini-3.8-flash-medium through unchanged", () => {
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-medium"), "gemini-3.8-flash-medium");
});

test("(#3696) resolveAntigravityModelId passes gemini-3.8-flash-low through unchanged", () => {
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-low"), "gemini-3.8-flash-low");
});

test("(#3696) no two ANTIGRAVITY_PUBLIC_MODELS entries resolve to the same upstream id", () => {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const model of ANTIGRAVITY_PUBLIC_MODELS) {
    const upstream = resolveAntigravityModelId(model.id);
    if (seen.has(upstream)) {
      collisions.push(`${model.id} and ${seen.get(upstream)} both resolve to "${upstream}"`);
    } else {
      seen.set(upstream, model.id);
    }
  }
  assert.deepEqual(collisions, [], `upstream-id collisions: ${collisions.join("; ")}`);
});
