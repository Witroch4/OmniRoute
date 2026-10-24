import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { getTokenLimit } from "../../open-sse/services/contextManager.ts";

const V26 = "mimo-v2.6-flash-free";
const REAL_WINDOW = 1048576;

// Fork: opencode-go is the Go v2 catalog (models.dev, 2026-10-24), where the free MiMo V2.6 id is
// not served (Go v2 lists mimo-v2.6-flash / mimo-v2.6-pro, both with their 1M window declared).
test("opencode registries declare an explicit real contextLength for mimo-v2.6-flash-free", () => {
  for (const provider of ["opencode-zen"]) {
    const row = REGISTRY[provider].models.find((m) => m.id === V26);
    assert.notEqual(
      row?.contextLength,
      undefined,
      `${provider} should declare its own real contextLength for ${V26} instead of relying on the 200000 provider default`
    );
  }
});

test("contextManager.getTokenLimit resolves mimo-v2.6-flash-free to its real 1M window, not the 200000 provider default", () => {
  assert.equal(getTokenLimit("opencode-zen", V26), REAL_WINDOW);
  assert.equal(getTokenLimit("opencode-go", "mimo-v2.6-flash"), REAL_WINDOW);
});

test("mimo-v2.5-free resolves to its real 1M window, not a stale understated registry value", () => {
  assert.equal(getTokenLimit("opencode-zen", "mimo-v2.5-free"), REAL_WINDOW);
});
