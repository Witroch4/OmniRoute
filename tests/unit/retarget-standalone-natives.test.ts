/**
 * The Docker image compiles `next build` on the build machine's own CPU and then swaps the
 * native modules of the standalone bundle for the target's (scripts/build/
 * retarget-standalone-natives.mjs). A binary for the wrong CPU left in the bundle crashes the
 * container on the Orange Pi, so the script must replace platform packages, replace compiled
 * addons, keep multi-platform packages, and refuse anything it cannot prove is right.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  counterpartNames,
  normalizeArch,
  retargetStandaloneNatives,
} from "../../scripts/build/retarget-standalone-natives.mjs";
import { readNativeBinaryTarget } from "../../scripts/build/native-binary-compat.mjs";

const MACHINE = { x64: 0x3e, arm64: 0xb7 } as const;

/** Minimal 64-byte little-endian ELF header for the given CPU, plus a payload tag. */
function elf(arch: keyof typeof MACHINE, tag: string): Buffer {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2; // 64-bit
  header[5] = 1; // little endian
  header[6] = 1;
  header.writeUInt16LE(3, 16); // ET_DYN
  header.writeUInt16LE(MACHINE[arch], 18);
  return Buffer.concat([header, Buffer.from(tag)]);
}

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function pkg(dir: string, manifest: Record<string, unknown>) {
  write(path.join(dir, "package.json"), JSON.stringify(manifest));
}

function archOf(file: string): string[] | undefined {
  return readNativeBinaryTarget(file)?.architectures;
}

/** Bundle built on x64 and an arm64 install of the same lockfile. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retarget-natives-"));
  const standalone = path.join(root, "standalone");
  // App root of the target build (the Dockerfile bind-mounts target-natives:/app at
  // /opt/target): node_modules installed for the target + the app's own addons.
  const targetRoot = path.join(root, "target");
  const target = path.join(targetRoot, "node_modules");
  const nm = path.join(standalone, "node_modules");

  // Platform package pair (sharp's prebuilt binary).
  pkg(path.join(nm, "@img/sharp-linux-x64"), { name: "@img/sharp-linux-x64", version: "0.35.5", cpu: ["x64"] });
  write(path.join(nm, "@img/sharp-linux-x64/lib/sharp-linux-x64.node"), elf("x64", "sharp"));
  pkg(path.join(target, "@img/sharp-linux-arm64"), { name: "@img/sharp-linux-arm64", version: "0.35.5", cpu: ["arm64"] });
  write(path.join(target, "@img/sharp-linux-arm64/lib/sharp-linux-arm64.node"), elf("arm64", "sharp"));

  // Addon compiled at install time, present twice (Turbopack external copy under .build).
  for (const dir of [path.join(nm, "better-sqlite3"), path.join(standalone, ".build/next/node_modules/better-sqlite3-90e2")]) {
    pkg(dir, { name: "better-sqlite3", version: "13.0.3" });
    write(path.join(dir, "lib/index.js"), "module.exports = 1;");
    write(path.join(dir, "build/Release/better_sqlite3.node"), elf("x64", "sqlite"));
    // Non-ELF leftovers of the build machine's compile, next to the binary.
    write(path.join(dir, "build/Release/obj.target/deps/sqlite3.a"), "!<arch>\nx64 objects");
    write(path.join(dir, "build/config.gypi"), '{"target_arch":"x64"}');
  }
  pkg(path.join(target, "better-sqlite3"), { name: "better-sqlite3", version: "13.0.3" });
  write(path.join(target, "better-sqlite3/lib/index.js"), "module.exports = 1;");
  write(path.join(target, "better-sqlite3/build/Release/better_sqlite3.node"), elf("arm64", "sqlite"));
  write(path.join(target, "better-sqlite3/build/Release/obj.target/deps/sqlite3.a"), "!<arch>\narm64 objects");
  write(path.join(target, "better-sqlite3/build/config.gypi"), '{"target_arch":"arm64"}');
  // Left out of the bundle by the trace; must stay out.
  write(path.join(target, "better-sqlite3/deps/sqlite3/sqlite3.c"), "/* amalgamation */");

  // Multi-platform package: ships every CPU itself, identical in both installs.
  for (const base of [nm, target]) {
    pkg(path.join(base, "onnxruntime-node"), { name: "onnxruntime-node", version: "1.30.0" });
    write(path.join(base, "onnxruntime-node/bin/linux/x64/onnx.node"), elf("x64", "onnx"));
    write(path.join(base, "onnxruntime-node/bin/linux/arm64/onnx.node"), elf("arm64", "onnx"));
  }

  // The app's own addon, built by `npm run build` and copied outside node_modules.
  const addon = "src/mitm/tproxy/native/build/Release/transparent.node";
  write(path.join(standalone, addon), elf("x64", "tproxy"));
  write(path.join(targetRoot, addon), elf("arm64", "tproxy"));

  // Plain JS package: must not be touched.
  pkg(path.join(nm, "plain-js"), { name: "plain-js", version: "1.0.0" });
  write(path.join(nm, "plain-js/index.js"), "standalone copy");

  return { root, standalone, target, targetRoot, nm, addon };
}

const quiet = () => {};

test("retargets platform packages and compiled addons, keeps multi-platform packages", () => {
  const { root, standalone, targetRoot, nm, addon } = fixture();
  try {
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", log: quiet });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.replacedPlatform, ["@img/sharp-linux-x64 -> @img/sharp-linux-arm64"]);

    assert.equal(fs.existsSync(path.join(nm, "@img/sharp-linux-x64")), false, "x64 platform package removed");
    assert.deepEqual(archOf(path.join(nm, "@img/sharp-linux-arm64/lib/sharp-linux-arm64.node")), ["arm64"]);

    assert.deepEqual(archOf(path.join(nm, "better-sqlite3/build/Release/better_sqlite3.node")), ["arm64"]);
    assert.deepEqual(
      archOf(path.join(standalone, ".build/next/node_modules/better-sqlite3-90e2/build/Release/better_sqlite3.node")),
      ["arm64"],
      "the hashed Turbopack external copy is retargeted too"
    );
    assert.equal(
      fs.existsSync(path.join(nm, "better-sqlite3/deps/sqlite3/sqlite3.c")),
      false,
      "only the binaries are swapped; files the trace left out do not come back"
    );
    for (const dir of [path.join(nm, "better-sqlite3"), path.join(standalone, ".build/next/node_modules/better-sqlite3-90e2")]) {
      assert.equal(
        fs.readFileSync(path.join(dir, "build/Release/obj.target/deps/sqlite3.a"), "utf8"),
        "!<arch>\narm64 objects",
        "non-ELF build leftovers next to the binary are swapped too"
      );
      assert.equal(fs.readFileSync(path.join(dir, "build/config.gypi"), "utf8"), '{"target_arch":"arm64"}');
    }
    assert.equal(fs.readFileSync(path.join(nm, "better-sqlite3/lib/index.js"), "utf8"), "module.exports = 1;");

    assert.deepEqual(archOf(path.join(nm, "onnxruntime-node/bin/linux/x64/onnx.node")), ["x64"], "multi-platform kept");
    assert.deepEqual(archOf(path.join(standalone, addon)), ["arm64"], "the app's own addon is retargeted");
    assert.deepEqual(result.replacedLoose, [addon]);
    assert.equal(fs.readFileSync(path.join(nm, "plain-js/index.js"), "utf8"), "standalone copy");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a platform package has no counterpart in the target install", () => {
  const { root, standalone, target, targetRoot } = fixture();
  try {
    fs.rmSync(path.join(target, "@img/sharp-linux-arm64"), { recursive: true });
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", log: quiet });
    assert.ok(result.problems.some((p: string) => p.includes("@img/sharp-linux-x64") && p.includes("no arm64 counterpart")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails when the target install itself carries an addon built for the wrong CPU", () => {
  const { root, standalone, target, targetRoot } = fixture();
  try {
    // e.g. a cross-compile that silently produced a host binary
    write(path.join(target, "better-sqlite3/build/Release/better_sqlite3.node"), elf("x64", "sqlite-host"));
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", log: quiet });
    assert.ok(
      result.problems.some((p: string) => p.includes("better_sqlite3.node") && p.includes("not built for arm64")),
      JSON.stringify(result.problems)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a native package is missing from the target install", () => {
  const { root, standalone, target, targetRoot } = fixture();
  try {
    fs.rmSync(path.join(target, "better-sqlite3"), { recursive: true });
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", log: quiet });
    assert.ok(result.problems.some((p: string) => p.includes("better-sqlite3@13.0.3") && p.includes("not in the target install")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("takes the target's whole package when its binaries live at other paths", () => {
  const { root, standalone, target, targetRoot, nm } = fixture();
  try {
    fs.rmSync(path.join(target, "better-sqlite3/build"), { recursive: true });
    write(path.join(target, "better-sqlite3/prebuilds/linux-arm64.node"), elf("arm64", "sqlite"));
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", log: quiet });
    assert.deepEqual(result.problems, []);
    assert.equal(fs.existsSync(path.join(nm, "better-sqlite3/build")), false, "x64 build dir gone with the package");
    assert.deepEqual(archOf(path.join(nm, "better-sqlite3/prebuilds/linux-arm64.node")), ["arm64"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails when the app's own addon has no build for the target", () => {
  const { root, standalone, targetRoot, addon } = fixture();
  try {
    fs.rmSync(path.join(targetRoot, addon));
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", log: quiet });
    assert.ok(
      result.problems.some((p: string) => p.includes("transparent.node") && p.includes("no arm64 build")),
      JSON.stringify(result.problems)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dry run reports without changing the bundle", () => {
  const { root, standalone, targetRoot, nm } = fixture();
  try {
    const result = retargetStandaloneNatives({ standalone, targetRoot, targetArch: "arm64", dryRun: true, log: quiet });
    assert.equal(result.replacedPlatform.length, 1);
    assert.ok(fs.existsSync(path.join(nm, "@img/sharp-linux-x64")));
    assert.deepEqual(archOf(path.join(nm, "better-sqlite3/build/Release/better_sqlite3.node")), ["x64"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("counterpart names swap only whole CPU tokens", () => {
  assert.deepEqual(counterpartNames("@img/sharp-linux-x64", "x64", "arm64"), ["@img/sharp-linux-arm64", "@img/sharp-linux-aarch64"]);
  assert.ok(counterpartNames("@wreq-js/binding-linux-x64-gnu", "x64", "arm64").includes("@wreq-js/binding-linux-arm64-gnu"));
  assert.ok(counterpartNames("sqlite-vec-linux-arm64", "arm64", "x64").includes("sqlite-vec-linux-x64"));
  assert.deepEqual(counterpartNames("x64-unrelated-name-ok", "arm64", "x64"), []);
});

test("Docker and Node arch names are both accepted", () => {
  assert.equal(normalizeArch("amd64"), "x64");
  assert.equal(normalizeArch("arm64"), "arm64");
  assert.equal(normalizeArch("aarch64"), "arm64");
  assert.throws(() => normalizeArch("riscv64"), /unsupported target arch/);
});
