import assert from "node:assert/strict";
import test from "node:test";

import { OPENCODE_ZEN_GO_SHARED_MODELS } from "../../open-sse/config/opencodeZenGoSharedModels.ts";
import { opencode_zenProvider } from "../../open-sse/config/providers/registry/opencode/zen/index.ts";
import { opencode_goProvider } from "../../open-sse/config/providers/registry/opencode/go/index.ts";

test("every OPENCODE_ZEN_GO_SHARED_MODELS entry is present, unmodified, exactly once in opencode-zen", () => {
  for (const shared of OPENCODE_ZEN_GO_SHARED_MODELS) {
    const matches = opencode_zenProvider.models.filter((m) => m.id === shared.id);
    assert.equal(matches.length, 1, `${shared.id} must appear exactly once in opencode-zen`);
    assert.deepEqual(matches[0], shared, `${shared.id} must match the shared definition exactly`);
  }
});

// Fork: opencode-go is the Go v2 catalog (models.dev, 2026-10-24) with its own per-model limits,
// vision and reasoning fields, so it does not spread the shared Zen/Go rows: kimi-k2.7-code is
// declared with its v2 metadata and qwen3.5-plus / qwen3.6-plus are no longer served on Go.
test("opencode-go carries each shared id still served on Go exactly once (v2 metadata)", () => {
  for (const shared of OPENCODE_ZEN_GO_SHARED_MODELS) {
    const matches = opencode_goProvider.models.filter((m) => m.id === shared.id);
    assert.ok(matches.length <= 1, `${shared.id} must not be duplicated in opencode-go`);
  }
  assert.equal(
    opencode_goProvider.models.filter((m) => m.id === "kimi-k2.7-code").length,
    1,
    "kimi-k2.7-code stays on Go"
  );
});

test("OPENCODE_ZEN_GO_SHARED_MODELS is frozen (no accidental cross-registry mutation)", () => {
  assert.ok(Object.isFrozen(OPENCODE_ZEN_GO_SHARED_MODELS));
});

test("referenced non-shared model ids remain present", () => {
  const goIds = new Set(opencode_goProvider.models.map((m) => m.id));
  const zenIds = new Set(opencode_zenProvider.models.map((m) => m.id));
  // Fork: glm-5.1 is retired from the Go v2 catalog; glm-5.2 is the referenced GLM base.
  for (const id of ["minimax-m3", "glm-5.2"]) {
    assert.ok(goIds.has(id) || zenIds.has(id), `expected ${id} in go or zen`);
  }
});

test("models[0] is the intended dashboard default", () => {
  // Fork: the Go v2 catalog's first (newest) model is the dashboard default.
  assert.equal(opencode_goProvider.models[0].id, "glm-5.3-flash");
  assert.equal(opencode_zenProvider.models[0].id, "big-pickle");
});
