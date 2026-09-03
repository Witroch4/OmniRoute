/**
 * tests/unit/claude-client-version-override.test.ts
 *
 * The impersonated claude-cli version is on the hot path of EVERY Claude OAuth
 * request, so production needs to be able to move it without an image rebuild
 * (the ARM cross-build is ~1h). This mirrors the CODEX_CLIENT_VERSION override
 * that already exists for the identical failure mode on the OpenAI side.
 *
 * The override is deliberately validated more strictly than Codex's: the
 * identity guards assert the canonical value is a plain three-part version, and
 * this string is interpolated into a User-Agent header — so anything that could
 * carry a header separator, or merely break the semver shape, must be refused
 * in favour of the compiled-in default rather than reaching the wire.
 */
import test from "node:test";
import assert from "node:assert/strict";

const ENV = "CLAUDE_CODE_VERSION";
const mod = await import("../../open-sse/config/claudeClientVersion.ts");

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  }
}

test("falls back to the pinned default when the override is absent", () => {
  withEnv(undefined, () => {
    assert.equal(mod.getClaudeCodeClientVersion(), mod.PINNED_CLAUDE_CODE_VERSION);
  });
});

test("a well-formed override wins over the pinned default", () => {
  withEnv("2.1.300", () => {
    assert.equal(mod.getClaudeCodeClientVersion(), "2.1.300");
  });
  // The rollback path the override exists for: pinning back to the old release.
  withEnv("2.1.207", () => {
    assert.equal(mod.getClaudeCodeClientVersion(), "2.1.207");
  });
});

test("surrounding whitespace is tolerated, not treated as corruption", () => {
  withEnv("  2.1.260  ", () => {
    assert.equal(mod.getClaudeCodeClientVersion(), "2.1.260");
  });
});

test("malformed or unsafe overrides fall back to the default instead of reaching the wire", () => {
  const rejected = [
    "",
    "   ",
    "latest",
    "2.1",
    "2.1.251.3",
    "v2.1.251",
    "2.1.251-beta",
    "2.1.251 (external, cli)",
    "2.1.251\r\nX-Injected: 1",
    "2.1.251\nHost: evil",
    "../../etc/passwd",
    "99999.1.1",
  ];
  for (const value of rejected) {
    withEnv(value, () => {
      assert.equal(
        mod.getClaudeCodeClientVersion(),
        mod.PINNED_CLAUDE_CODE_VERSION,
        `override ${JSON.stringify(value)} should have been refused`
      );
    });
  }
});

test("the resolved version always satisfies the shape the identity guards assert", () => {
  for (const candidate of [undefined, "2.1.251", "3.0.0", "garbage", "2.1.251\r\nx: y"]) {
    withEnv(candidate, () => {
      assert.match(mod.getClaudeCodeClientVersion(), /^\d+\.\d+\.\d+$/);
    });
  }
});
