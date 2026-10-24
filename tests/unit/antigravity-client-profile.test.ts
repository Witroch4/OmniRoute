import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { normalizeAntigravityClientProfile } from "../../src/shared/constants/antigravityClientProfile.ts";
import {
  applyAntigravityClientProfileHeaders,
  getAntigravityBootstrapHeaders,
  getAntigravityClientProfile,
} from "../../open-sse/services/antigravityClientProfile.ts";
import { antigravityCliUserAgent } from "../../open-sse/config/antigravityCliClient.ts";
import { antigravityUserAgent } from "../../open-sse/services/antigravityHeaders.ts";
import { deriveAntigravityMachineId } from "../../open-sse/services/antigravityIdentity.ts";
import {
  seedAntigravityVersionCache,
  clearAntigravityVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

const require = createRequire(import.meta.url);
const { machineIdSync } = require("node-machine-id") as {
  machineIdSync: (original?: boolean) => string;
};

test.afterEach(() => {
  clearAntigravityVersionCache();
});

test("normalizeAntigravityClientProfile defaults to cli and reads legacy harness/sdk as cli", () => {
  assert.equal(normalizeAntigravityClientProfile("cli"), "cli");
  assert.equal(normalizeAntigravityClientProfile("harness"), "cli");
  assert.equal(normalizeAntigravityClientProfile("SDK"), "cli");
  assert.equal(normalizeAntigravityClientProfile("ide"), "ide");
  assert.equal(normalizeAntigravityClientProfile(undefined), "cli");
  assert.equal(normalizeAntigravityClientProfile("bogus"), "cli");
});

test("getAntigravityClientProfile reads providerSpecificData.clientProfile per connection", () => {
  assert.equal(
    getAntigravityClientProfile({ providerSpecificData: { clientProfile: "ide" } }),
    "ide"
  );
  assert.equal(
    getAntigravityClientProfile({ providerSpecificData: { clientProfile: "harness" } }),
    "cli"
  );
  assert.equal(getAntigravityClientProfile({ providerSpecificData: {} }), "cli");
});

test("applyAntigravityClientProfileHeaders replaces everything with the official CLI headers by default", () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-client-name": "antigravity",
    "x-machine-id": "m",
    "x-vscode-sessionid": "s",
    "X-Goog-Api-Client": "gl-node/22.21.1",
    "x-goog-user-project": "project-1",
    "Accept-Encoding": "gzip, deflate, br",
    Authorization: "Bearer token",
  };

  const profile = applyAntigravityClientProfileHeaders(
    headers,
    { connectionId: "conn-1", providerSpecificData: {} },
    { project: "project-1" }
  );

  assert.equal(profile, "cli");
  // Exact set AND order of the captured agy 1.4.7 wire headers.
  assert.deepEqual(Object.entries(headers), [
    ["User-Agent", antigravityCliUserAgent()],
    ["Authorization", "Bearer token"],
    ["Content-Type", "application/json"],
    ["Accept-Encoding", "gzip"],
  ]);
});

test("applyAntigravityClientProfileHeaders keeps the legacy IDE fingerprint only when opted in", () => {
  seedAntigravityVersionCache("2.5.5");
  const headers: Record<string, string> = {
    Authorization: "Bearer token",
    "Content-Type": "application/json",
  };

  applyAntigravityClientProfileHeaders(
    headers,
    { connectionId: "conn-1", providerSpecificData: { clientProfile: "ide" } },
    { project: "project-1" }
  );

  assert.match(headers["User-Agent"], /^Antigravity\/2\.5\.5 /);
  assert.equal(headers["x-client-name"], "antigravity");
  assert.equal(headers["x-client-version"], "2.5.5");
  assert.equal(headers["x-goog-user-project"], "project-1");
});

test("antigravityUserAgent (legacy ide profile) keeps its platform tokens", () => {
  assert.equal(
    antigravityUserAgent("4.2.0", "darwin"),
    "Antigravity/4.2.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.7444.175 Electron/39.2.3"
  );
  assert.equal(
    antigravityUserAgent("4.2.0", "win32"),
    "Antigravity/4.2.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.7444.175 Electron/39.2.3"
  );
  assert.equal(
    antigravityUserAgent("4.2.0", "linux"),
    "Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3"
  );
});

test("deriveAntigravityMachineId uses the raw system machine id like Antigravity Manager", () => {
  let systemMachineId: string | null = null;
  try {
    systemMachineId = machineIdSync(true);
  } catch {
    systemMachineId = null;
  }
  if (!systemMachineId) return;

  assert.equal(deriveAntigravityMachineId(), systemMachineId);
});

test("getAntigravityBootstrapHeaders uses the official CLI headers for the default profile", () => {
  assert.deepEqual(Object.entries(getAntigravityBootstrapHeaders("cli", "token")), [
    ["User-Agent", antigravityCliUserAgent()],
    ["Authorization", "Bearer token"],
    ["Content-Type", "application/json"],
    ["Accept-Encoding", "gzip"],
  ]);
});

test("getAntigravityBootstrapHeaders keeps the legacy IDE bootstrap headers for ide", () => {
  seedAntigravityVersionCache("2.5.5");
  const headers = getAntigravityBootstrapHeaders("ide", "token");
  assert.equal(headers.Authorization, "Bearer token");
  assert.match(headers["User-Agent"], /^Antigravity\/2\.5\.5 /);
  assert.equal(headers["Client-Metadata"], JSON.stringify({ ideType: "ANTIGRAVITY" }));
});
