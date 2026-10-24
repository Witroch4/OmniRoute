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
import fs from "node:fs";
import path from "node:path";

const id = await import("../../open-sse/executors/claudeIdentity.ts");
const hdr = await import("../../open-sse/config/anthropicHeaders.ts");
const compat = await import("../../open-sse/services/claudeCodeCompatible.ts");
const bridge = await import("../../open-sse/services/ccBridgeTransforms.ts");
const codexCfg = await import("../../open-sse/config/codexClient.ts");
const pinned = await import("../../open-sse/config/claudeClientVersion.ts");
const canonical = await import("../../src/shared/constants/claudeCodeClient.ts");

test("Claude CLI version constants are in lockstep across all 4 sources", () => {
  const V = canonical.CLAUDE_CODE_CLIENT_VERSION;
  assert.equal(id.CLAUDE_CODE_VERSION, V, "claudeIdentity.CLAUDE_CODE_VERSION drift");
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

test("Claude CLI is pinned to the current published 2.1.281 release", () => {
  // Bumped 2026-09-03 from 2.1.207: cc/claude-fable-5-1 returned upstream 400
  // "Claude Code 2.1.207 does not support this model; version 2.1.251 or newer
  // is required", while every other Claude id answered normally on the same key.
  // 2.1.281 is the real latest release, not the 2.1.280 floor the Opus 5.5 error names.
  // This asserts the compiled-in DEFAULT, not the env override, so a temporary
  // CLAUDE_CODE_VERSION in production cannot silently become the pinned value.
  assert.equal(pinned.PINNED_CLAUDE_CODE_VERSION, "2.1.281");
  assert.equal(id.CLAUDE_CODE_VERSION, pinned.PINNED_CLAUDE_CODE_VERSION);
  // The fork facade and upstream's canonical module are ONE source after the 3.8.53 sync.
  assert.equal(pinned.PINNED_CLAUDE_CODE_VERSION, canonical.CLAUDE_CODE_CLIENT_VERSION);
  assert.equal(pinned.getClaudeCodeClientVersion, canonical.getClaudeCodeClientVersion);
});

test("Codex client is pinned to the current published 0.160.0 release", () => {
  assert.equal(codexCfg.getCodexClientVersion(), "0.160.0");
  assert.equal(codexCfg.getCodexUserAgent(), "codex-cli/0.160.0 (Windows 10.0.26200; x64)");
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, "0.160.0");
});

test("Claude CLI pin clears Anthropic's Opus 5.5 model gate (>= 2.1.280)", () => {
  const [major, minor, patch] = canonical.CLAUDE_CODE_CLIENT_VERSION.split(".").map(Number);
  const meetsGate = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 280)));
  assert.ok(
    meetsGate,
    `claude-cli pin ${canonical.CLAUDE_CODE_CLIENT_VERSION} < 2.1.280 — Anthropic rejects claude-opus-5-5 with 400 "Claude Code ${canonical.CLAUDE_CODE_CLIENT_VERSION} does not support this model"`
  );
});

// Fork: the pin is max(fork 2.1.281, upstream capture 2.1.280); the build revision,
// SDK and runtime stay the upstream capture of 2.1.280.
test("Claude CLI wire versions match the pinned 2.1.281 release", () => {
  assert.equal(canonical.CLAUDE_CODE_CLIENT_VERSION, "2.1.281");
  assert.equal(canonical.CLAUDE_CODE_CLIENT_BUILD_REVISION, "1e2");
  assert.equal(canonical.CLAUDE_CODE_CLIENT_BILLING_VERSION, "2.1.281.1e2");
  assert.equal(canonical.CLAUDE_CODE_SDK_PACKAGE_VERSION, "0.112.1");
  assert.equal(canonical.CLAUDE_CODE_RUNTIME_VERSION, "v26.3.0");
  assert.equal(
    compat.CLAUDE_CODE_COMPATIBLE_STAINLESS_PACKAGE_VERSION,
    canonical.CLAUDE_CODE_SDK_PACKAGE_VERSION
  );
  assert.equal(
    compat.CLAUDE_CODE_COMPATIBLE_STAINLESS_RUNTIME_VERSION,
    canonical.CLAUDE_CODE_RUNTIME_VERSION
  );
  assert.equal(hdr.CLAUDE_CLI_STAINLESS_PACKAGE_VERSION, canonical.CLAUDE_CODE_SDK_PACKAGE_VERSION);
  assert.equal(hdr.CLAUDE_CLI_STAINLESS_RUNTIME_VERSION, canonical.CLAUDE_CODE_RUNTIME_VERSION);
  assert.equal(hdr.CLAUDE_CLI_BILLING_VERSION, canonical.CLAUDE_CODE_CLIENT_BILLING_VERSION);
});

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Codex client version locksteps Dockerfile @openai/codex", () => {
  const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  const match = dockerfile.match(/@openai\/codex@([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.ok(match, "Dockerfile must pin @openai/codex@x.y.z");
  const pinned = match[1];
  assert.notEqual(pinned, "0.149.0");
  assert.equal(codexCfg.DEFAULT_CODEX_CLIENT_VERSION, pinned);
  assert.equal(codexCfg.getCodexClientVersion(), pinned);
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, pinned);
  assert.equal(codexCfg.getCodexCliRsHeaders()["User-Agent"], `codex_cli_rs/${pinned}`);
});

test("Codex client version env override still wins", async () => {
  await withEnv({ CODEX_CLIENT_VERSION: "0.99.0" }, () => {
    assert.equal(codexCfg.getCodexClientVersion(), "0.99.0");
    assert.equal(codexCfg.getCodexDefaultHeaders().Version, "0.99.0");
  });
});

// contract changed by #15132: the Codex route now prefers the saved account inventory
// (cache) over the GitHub manifest when live discovery fails, so the GitHub fallback moved
// AFTER the cache branch, and the live branch persists via persistDiscoveredModels() +
// buildResponse() instead of buildApiDiscoveryResponse(). The invariant is unchanged: only
// the live branch may persist; the GitHub-catalog fallback must never write the cache.
function assertGithubFallbackDoesNotPersist() {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/providers/[id]/models/route.ts"),
    "utf8"
  );
  const idx = src.indexOf("Codex live catalog unavailable — using GitHub model catalog");
  assert.ok(idx > 0);
  const start = src.lastIndexOf("if (githubCatalogModels && githubCatalogModels.length > 0)", idx);
  const end = src.indexOf("Codex live and GitHub catalogs unavailable", idx);
  assert.ok(start > 0 && end > start);
  const window = src.slice(start, end);
  assert.match(window, /buildResponse\s*\(/);
  assert.doesNotMatch(window, /buildApiDiscoveryResponse\s*\(/);
  assert.doesNotMatch(window, /persistDiscoveredModels\s*\(/);

  const liveIdx = src.lastIndexOf("if (liveModels && liveModels.length > 0)", start);
  const cacheIdx = src.lastIndexOf("Codex live catalog unavailable — using cached catalog", start);
  assert.ok(liveIdx > 0 && liveIdx < cacheIdx && cacheIdx < start);
  const liveWindow = src.slice(liveIdx, cacheIdx);
  assert.match(liveWindow, /persistDiscoveredModels\s*\(/);
}

test("test 7: live-empty GitHub catalog path does not call persist", () => {
  assertGithubFallbackDoesNotPersist();
});

test("Codex client version locksteps Dockerfile @openai/codex and env override", () => {
  const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  const match = dockerfile.match(/@openai\/codex@([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.ok(match, "Dockerfile must pin @openai/codex@x.y.z");
  const pinned = match[1];
  assert.notEqual(pinned, "0.149.0");
  assert.equal(codexCfg.DEFAULT_CODEX_CLIENT_VERSION, pinned);
  assert.equal(codexCfg.getCodexClientVersion(), pinned);
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, pinned);
  assert.equal(codexCfg.getCodexCliRsHeaders()["User-Agent"], `codex_cli_rs/${pinned}`);
});

test("test 7: live-empty GitHub catalog path does not call persist", () => {
  assertGithubFallbackDoesNotPersist();
});
