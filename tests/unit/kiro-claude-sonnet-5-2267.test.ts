import test from "node:test";
import assert from "node:assert/strict";

import { kiroProvider } from "../../open-sse/config/providers/registry/kiro/index.ts";

// Regression for the port of decolua/9router#2267 ("claude-sonnet-5 is not supported"),
// upstream PR diegosouzapw/OmniRoute#5796.
//
// The Kiro provider's OAuth model catalog lives in `registry/kiro/index.ts` `models[]`.
// That list is both the model selector's source and the fallback for the live
// CodeWhisperer ListAvailableModels fetch (`kiroModels.ts::toFallbackResult`). Back when
// #2267 was filed, `claude-sonnet-5` was believed to be a real, shipping model already
// served by Kiro but missing from this list, so it was added (mirroring the existing
// Claude entries) with the 1M-context / 128K-output capability Kiro was believed to serve
// it at.
//
// 2026-07-25: live-tested against two real Amazon Q/Kiro connections (one with fully
// healthy quota) and `claude-sonnet-5` 400'd "Invalid model" on both, every time — Kiro's
// current catalog has no "Sonnet 5" at all (confirmed against the live Kiro app's own
// model picker: "Claude Sonnet 4.5" and a separate "Claude Sonnet 4" regular tier, no
// "Sonnet 5"). It was removed from the registry and replaced with `claude-sonnet-4`,
// confirmed 200 on the same connection that rejected `claude-sonnet-5`. This test now
// guards the corrected entry instead.

test("kiro registry exposes claude-sonnet-4 (not the removed claude-sonnet-5)", () => {
  const ids = kiroProvider.models.map((m) => m.id);
  assert.ok(
    ids.includes("claude-sonnet-4"),
    `expected kiro registry to include claude-sonnet-4, got: ${ids.join(", ")}`
  );
  assert.ok(
    !ids.includes("claude-sonnet-5"),
    `claude-sonnet-5 does not exist in Kiro's catalog (live-verified 2026-07-25) and must not reappear, got: ${ids.join(", ")}`
  );
});

test("kiro claude-sonnet-4 declares the same capability shape as claude-sonnet-4.5", () => {
  const sonnet4 = kiroProvider.models.find((m) => m.id === "claude-sonnet-4");
  assert.ok(sonnet4, "claude-sonnet-4 must be present in the kiro registry");
  assert.equal(sonnet4.name, "Claude Sonnet 4");
  assert.equal(sonnet4.contextLength, 200000);
  assert.equal(sonnet4.maxOutputTokens, 64000);
});
