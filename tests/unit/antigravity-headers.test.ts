import assert from "node:assert/strict";
import test from "node:test";

import {
  getAntigravityContentHeaders,
  getAntigravityLoadCodeAssistMetadata,
  getAntigravityOAuthUserAgent,
} from "../../open-sse/services/antigravityHeaders.ts";
import {
  ANTIGRAVITY_CLI_OAUTH_USER_AGENT,
  antigravityCliUserAgent,
} from "../../open-sse/config/antigravityCliClient.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

// Fork: the Antigravity fingerprint is the official `agy` CLI as captured on the wire
// (open-sse/config/antigravityCliClient.ts). Upstream's IDE/CLI grammars (#8013/#11969/
// #16559: darwin/arm64 pinned, no `cl=`, numeric loadCodeAssist enums) do not apply here.

test.afterEach(() => {
  clearAntigravityVersionCaches();
});

test("cli content headers are exactly the official CLI's, in its order", () => {
  assert.deepEqual(Object.entries(getAntigravityContentHeaders("cli", "cli-token")), [
    ["User-Agent", antigravityCliUserAgent()],
    ["Authorization", "Bearer cli-token"],
    ["Content-Type", "application/json"],
    ["Accept-Encoding", "gzip"],
  ]);
  assert.deepEqual(Object.keys(getAntigravityContentHeaders("cli")), [
    "User-Agent",
    "Content-Type",
    "Accept-Encoding",
  ]);
});

test("the CLI User-Agent carries the host OS/arch and the build changelist", () => {
  assert.match(
    antigravityCliUserAgent(),
    /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=[^;]+; arch=[^;]+; cl=\d+; auth_method=consumer\)$/
  );
});

test("a seeded CLI version never reaches the wire without its changelist", () => {
  const before = antigravityCliUserAgent();
  seedAntigravityCliVersionCache("1.2.0");
  assert.equal(antigravityCliUserAgent(), before);
  assert.equal(new Headers(getAntigravityContentHeaders("cli", "t")).get("User-Agent"), before);
});

test("content headers never carry identity headers no official client sends", () => {
  seedAntigravityIdeVersionCache("2.5.5");
  for (const profile of ["cli", "ide"] as const) {
    const headers = new Headers(getAntigravityContentHeaders(profile, "token"));
    for (const absent of [
      "x-client-name",
      "x-client-version",
      "x-machine-id",
      "x-vscode-sessionid",
      "X-Goog-Api-Client",
      "Client-Metadata",
    ]) {
      assert.equal(headers.get(absent), null, `${profile}: ${absent} must be absent`);
    }
    assert.equal(headers.get("Authorization"), "Bearer token");
  }
});

test("legacy ide content headers keep the legacy IDE User-Agent", () => {
  seedAntigravityIdeVersionCache("2.5.5");
  const headers = new Headers(getAntigravityContentHeaders("ide", "ide-token"));
  assert.match(headers.get("User-Agent") ?? "", /^Antigravity\/2\.5\.5 /);
});

test("OAuth User-Agent: Go oauth2 client for cli, legacy native UA for ide", () => {
  seedAntigravityIdeVersionCache("2.5.5");
  assert.equal(getAntigravityOAuthUserAgent("cli"), ANTIGRAVITY_CLI_OAUTH_USER_AGENT);
  assert.equal(getAntigravityOAuthUserAgent("cli"), "Go-http-client/1.1");
  assert.equal(getAntigravityOAuthUserAgent("ide"), "vscode/1.X.X (Antigravity/2.5.5)");
});

test("loadCodeAssist metadata is the CLI's string ideType, no numeric enums", () => {
  assert.deepEqual(getAntigravityLoadCodeAssistMetadata(), { ideType: "ANTIGRAVITY" });
  assert.equal("platform" in getAntigravityLoadCodeAssistMetadata(), false);
  assert.equal("pluginType" in getAntigravityLoadCodeAssistMetadata(), false);
});
