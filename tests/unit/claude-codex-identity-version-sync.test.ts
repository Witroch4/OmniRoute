/**
 * tests/unit/claude-codex-identity-version-sync.test.ts
 *
 * Guards the pinned CLI identity versions against drift. The Claude Code version
 * is now derived by every surface from ONE source (config/claudeClientVersion.ts),
 * so a partial bump is no longer expressible — before 2026-09-03 it was copied
 * into six places (claudeIdentity, anthropicHeaders, claudeCodeCompatible,
 * ccBridgeTransforms, glmProvider and the clientIdentityProfiles preset) and the
 * docstring here claimed there were four. The Codex client version lives in
 * codexClient, which has had the same env-override shape since 2026-08-29.
 *
 * When you capture a newer claude-cli / codex release, bump ALL constants and
 * update the pinned values below in the same change.
 */

import test from "node:test";
import assert from "node:assert/strict";

const id = await import("../../open-sse/executors/claudeIdentity.ts");
const hdr = await import("../../open-sse/config/anthropicHeaders.ts");
const compat = await import("../../open-sse/services/claudeCodeCompatible.ts");
const bridge = await import("../../open-sse/services/ccBridgeTransforms.ts");
const codexCfg = await import("../../open-sse/config/codexClient.ts");
const pinned = await import("../../open-sse/config/claudeClientVersion.ts");

test("Claude CLI version constants are in lockstep across all 4 sources", () => {
  const V = id.CLAUDE_CODE_VERSION;
  assert.equal(hdr.CLAUDE_CLI_VERSION, V, "anthropicHeaders.CLAUDE_CLI_VERSION drift");
  assert.equal(compat.CLAUDE_CODE_COMPATIBLE_VERSION, V, "claudeCodeCompatible version drift");
  assert.equal(bridge.DEFAULT_CLAUDE_CODE_VERSION, V, "ccBridgeTransforms version drift");
  assert.equal(
    hdr.CLAUDE_CLI_USER_AGENT,
    `claude-cli/${V} (external, cli)`,
    "CLAUDE_CLI_USER_AGENT drift"
  );
  assert.equal(
    compat.CLAUDE_CODE_COMPATIBLE_USER_AGENT,
    `claude-cli/${V} (external, sdk-cli)`,
    "CLAUDE_CODE_COMPATIBLE_USER_AGENT drift"
  );
});

test("Claude CLI is pinned to the current published 2.1.259 release", () => {
  // Bumped 2026-09-03 from 2.1.207: cc/claude-fable-5-1 returned upstream 400
  // "Claude Code 2.1.207 does not support this model; version 2.1.251 or newer
  // is required", while every other Claude id answered normally on the same key.
  // 2.1.259 is the real latest release, not the 2.1.251 floor the error names.
  // This asserts the compiled-in DEFAULT, not the env override, so a temporary
  // CLAUDE_CODE_VERSION in production cannot silently become the pinned value.
  assert.equal(pinned.PINNED_CLAUDE_CODE_VERSION, "2.1.259");
  assert.equal(id.CLAUDE_CODE_VERSION, pinned.PINNED_CLAUDE_CODE_VERSION);
});

test("Codex client is pinned to the captured 0.151.0 release", () => {
  assert.equal(codexCfg.getCodexClientVersion(), "0.151.0");
  assert.equal(codexCfg.getCodexUserAgent(), "codex-cli/0.151.0 (Windows 10.0.26200; x64)");
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, "0.151.0");
});
