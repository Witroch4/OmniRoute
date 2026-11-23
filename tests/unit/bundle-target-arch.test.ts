/**
 * Cross-arch Docker builds compile on the build machine's CPU, and Turbopack folds
 * `process.arch` comparisons at compile time with that machine's value: an arm64 image
 * built on x86 shipped cursor's detectArch() as "x86_64" (the QEMU build shipped "aarch64").
 * The Dockerfile passes the target CPU only for cross builds, and next.config.mjs defines
 * `process.arch` for the server bundles from it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleTargetArchDefines } from "../../scripts/build/bundleTargetArch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("no define unless OMNIROUTE_BUNDLE_TARGET_ARCH is set", () => {
  assert.deepEqual(bundleTargetArchDefines({}), {});
  assert.deepEqual(bundleTargetArchDefines({ OMNIROUTE_BUNDLE_TARGET_ARCH: "  " }), {});
});

test("Docker and Node arch names map to Node's process.arch", () => {
  assert.deepEqual(bundleTargetArchDefines({ OMNIROUTE_BUNDLE_TARGET_ARCH: "arm64" }), { "process.arch": "arm64" });
  assert.deepEqual(bundleTargetArchDefines({ OMNIROUTE_BUNDLE_TARGET_ARCH: "aarch64" }), { "process.arch": "arm64" });
  assert.deepEqual(bundleTargetArchDefines({ OMNIROUTE_BUNDLE_TARGET_ARCH: "amd64" }), { "process.arch": "x64" });
  assert.deepEqual(bundleTargetArchDefines({ OMNIROUTE_BUNDLE_TARGET_ARCH: "x64" }), { "process.arch": "x64" });
});

test("an unknown arch fails the build instead of compiling a wrong constant", () => {
  assert.throws(() => bundleTargetArchDefines({ OMNIROUTE_BUNDLE_TARGET_ARCH: "riscv64" }), /not supported/);
});

test("next.config.mjs feeds the define to the server bundles only when set", () => {
  const config = fs.readFileSync(path.join(repoRoot, "next.config.mjs"), "utf8");
  assert.match(config, /bundleTargetArchDefines\(process\.env\)/);
  assert.match(config, /compiler:\s*\{\s*defineServer:\s*bundleTargetArchServerDefines\s*\}/);
});

test("the Dockerfile exports the target arch for `npm run build` only on cross builds", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8").replace(/\\\n\s*/g, " ");
  const buildRun = dockerfile.split("\n").find((line) => line.startsWith("RUN") && line.includes("npm run build"));
  assert.ok(buildRun, "builder must run `npm run build`");
  const exportIdx = buildRun.indexOf('export OMNIROUTE_BUNDLE_TARGET_ARCH="${TARGETARCH}"');
  assert.ok(exportIdx >= 0, "the build step must export the target arch");
  assert.ok(exportIdx < buildRun.indexOf("npm run build"), "exported before `npm run build`, in the same RUN");
  assert.match(buildRun, /if \[ "\$\{TARGETARCH\}" != "\$\{BUILDARCH\}" \]; then export OMNIROUTE_BUNDLE_TARGET_ARCH/);
});
