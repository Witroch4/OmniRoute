import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_CLI_DEFAULT_CHANGELIST,
  ANTIGRAVITY_CLI_DEFAULT_VERSION,
  antigravityCliArch,
  antigravityCliOsType,
  antigravityCliUserAgent,
  getAntigravityCliBuild,
  getAntigravityCliCloudCodeHeaders,
  getAntigravityCliLoadCodeAssistMetadata,
  getAntigravityCliOAuthTokenHeaders,
} from "../../open-sse/config/antigravityCliClient.ts";

// Ground truth captured from the official agy 1.4.7 on 2026-10-24 (linux/amd64 host).
const CAPTURED_UA =
  "antigravity/cli/1.4.7 (aidev_client; os_type=linux; arch=amd64; cl=1006008713; auth_method=consumer)";

test("User-Agent reproduces the captured agy 1.4.7 string byte for byte", () => {
  assert.equal(antigravityCliUserAgent({ platform: "linux", arch: "x64", env: {} }), CAPTURED_UA);
});

test("os_type/arch follow the host the way the Go CLI names them", () => {
  assert.equal(antigravityCliOsType("linux"), "linux");
  assert.equal(antigravityCliOsType("darwin"), "darwin");
  assert.equal(antigravityCliOsType("win32"), "windows");
  assert.equal(antigravityCliArch("x64"), "amd64");
  assert.equal(antigravityCliArch("arm64"), "arm64");
  assert.equal(antigravityCliArch("ia32"), "386");
  assert.match(
    antigravityCliUserAgent({ platform: "linux", arch: "arm64", env: {} }),
    /os_type=linux; arch=arm64;/
  );
});

test("version and changelist override only as a valid pair", () => {
  const defaults = {
    version: ANTIGRAVITY_CLI_DEFAULT_VERSION,
    changelist: ANTIGRAVITY_CLI_DEFAULT_CHANGELIST,
  };
  assert.deepEqual(
    getAntigravityCliBuild({
      ANTIGRAVITY_CLI_VERSION: "1.5.0",
      ANTIGRAVITY_CLI_CHANGELIST: "1007000000",
    }),
    { version: "1.5.0", changelist: "1007000000" }
  );
  // A lone override would put a changelist from another build on the wire.
  assert.deepEqual(getAntigravityCliBuild({ ANTIGRAVITY_CLI_VERSION: "1.5.0" }), defaults);
  assert.deepEqual(getAntigravityCliBuild({ ANTIGRAVITY_CLI_CHANGELIST: "1007000000" }), defaults);
  assert.deepEqual(
    getAntigravityCliBuild({
      ANTIGRAVITY_CLI_VERSION: "1.5",
      ANTIGRAVITY_CLI_CHANGELIST: "1007000000",
    }),
    defaults
  );
  assert.deepEqual(
    getAntigravityCliBuild({ ANTIGRAVITY_CLI_VERSION: "1.5.0", ANTIGRAVITY_CLI_CHANGELIST: "abc" }),
    defaults
  );
});

test("Cloud Code headers are exactly the CLI's, in its order, and omit Authorization without a token", () => {
  assert.deepEqual(Object.keys(getAntigravityCliCloudCodeHeaders("t")), [
    "User-Agent",
    "Authorization",
    "Content-Type",
    "Accept-Encoding",
  ]);
  assert.equal(getAntigravityCliCloudCodeHeaders("t").Authorization, "Bearer t");
  assert.equal(getAntigravityCliCloudCodeHeaders("t")["Accept-Encoding"], "gzip");
  assert.deepEqual(Object.keys(getAntigravityCliCloudCodeHeaders(null)), [
    "User-Agent",
    "Content-Type",
    "Accept-Encoding",
  ]);
});

test("OAuth token headers and loadCodeAssist metadata match the CLI", () => {
  assert.deepEqual(getAntigravityCliOAuthTokenHeaders(), {
    "User-Agent": "Go-http-client/1.1",
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept-Encoding": "gzip",
  });
  assert.deepEqual(getAntigravityCliLoadCodeAssistMetadata(), { ideType: "ANTIGRAVITY" });
});
