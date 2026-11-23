#!/usr/bin/env node
/**
 * retarget-standalone-natives.mjs — make a standalone bundle built on one CPU ship for another.
 *
 * The Docker image compiles the app (`npm run build`) on the BUILD machine's own architecture
 * so the expensive Next.js build never runs under QEMU (an x86 builder producing the arm64
 * image for the Orange Pi took ~17 min for `next build` alone under emulation, ~2 min native).
 * The bundle is plain JavaScript except for the native pieces npm installed for the build
 * machine: platform packages (`@img/sharp-linux-x64`, `@wreq-js/binding-linux-x64-gnu`,
 * `sqlite-vec-linux-x64`, `@esbuild/linux-x64`, …) and addons compiled at install time
 * (`better-sqlite3/build/Release/*.node`). This script swaps exactly those for the copies in a
 * `node_modules` installed for the TARGET architecture from the same lockfile.
 *
 * The target side is an app root (`--target-root`) holding `node_modules` installed for the
 * target from the same lockfile, plus any addon the app builds from its own sources, compiled
 * for the target at the same relative path (src/mitm/tproxy/native/build/Release/
 * transparent.node, built by `npm run build` and copied into the bundle outside node_modules).
 *
 * Rules:
 *   1. A platform package whose `cpu` field excludes the target is removed and its target
 *      counterpart (same name with the CPU token swapped, same version) is copied in its
 *      place, taken from the target install. A missing counterpart fails the build.
 *   2. Any other package holding a native binary (ELF, Mach-O or PE) that is not
 *      byte-identical to the same file of the same name@version in the target install is
 *      replaced as a whole by the target install's copy. Multi-platform packages that ship
 *      every binary themselves (onnxruntime-node) are byte-identical and stay untouched.
 *   3. A native binary outside any package (the app's own addons) that is not built for the
 *      target is replaced by the file at the same relative path under the target root.
 *   4. Verification: afterwards every native binary in the WHOLE bundle must be an ELF for
 *      the target CPU, or (inside a package that also ships the target's ELF) byte-identical
 *      to the target install's copy; no platform package may exclude the target CPU, and no
 *      symlink may dangle. Any violation exits 1: an image that would crash on its own
 *      machine must not be produced.
 *
 * Usage:
 *   node scripts/build/retarget-standalone-natives.mjs \
 *     --standalone /app/.build/next/standalone --target-root /opt/target \
 *     --target-arch arm64 [--dry-run]
 *
 * `--target-arch` accepts Docker (`amd64`, `arm64`) or Node (`x64`, `arm64`) names.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeBinaryTarget } from "./native-binary-compat.mjs";

const DOCKER_TO_NODE_ARCH = { amd64: "x64", x86_64: "x64", x64: "x64", arm64: "arm64", aarch64: "arm64" };

/** CPU spellings used in platform package names, per Node arch. */
const ARCH_TOKENS = { x64: ["x64", "x86_64", "amd64"], arm64: ["arm64", "aarch64"] };

export function normalizeArch(value) {
  const arch = DOCKER_TO_NODE_ARCH[String(value || "").trim().toLowerCase()];
  if (!arch) throw new Error(`unsupported target arch: ${JSON.stringify(value)} (use amd64/x64 or arm64)`);
  return arch;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every package directory below `root`: a real directory directly inside a `node_modules`
 * (or inside an `@scope` there) that has a package.json with a name. Symlinks are not
 * followed — Turbopack's `.next/node_modules/<pkg>-<hash>` externals point at packages
 * this walk already reaches through `node_modules`.
 * `rootIsNodeModules` marks `root` itself as a node_modules directory whatever its name
 * (the target install is bind-mounted under another name).
 * @returns {{dir: string, name: string, version: string, cpu: string[]|null}[]}
 */
export function listPackages(root, { rootIsNodeModules = path.basename(root) === "node_modules" } = {}) {
  const found = [];
  const visit = (dir, insideNodeModules) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") {
        visit(full, true);
        continue;
      }
      if (insideNodeModules && entry.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
          if (scoped.isDirectory()) addPackage(path.join(full, scoped.name));
        }
        continue;
      }
      if (insideNodeModules) {
        addPackage(full);
        continue;
      }
      visit(full, false);
    }
  };
  const addPackage = (dir) => {
    const pkg = readJson(path.join(dir, "package.json"));
    if (pkg && typeof pkg.name === "string") {
      found.push({
        dir,
        name: pkg.name,
        version: String(pkg.version ?? ""),
        cpu: Array.isArray(pkg.cpu) ? pkg.cpu : null,
      });
    }
    // Nested node_modules (and anything else) below the package.
    visit(dir, false);
  };
  visit(root, rootIsNodeModules);
  return found;
}

/** Files of a package that are native binaries, excluding nested packages. */
export function nativeFilesOf(pkgDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.isFile() && readNativeBinaryTarget(full)) {
        out.push(full);
      }
    }
  };
  walk(pkgDir);
  return out;
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function cpuExcludes(cpu, arch) {
  if (!cpu || cpu.length === 0) return false;
  const allowed = cpu.filter((c) => !c.startsWith("!"));
  const denied = cpu.filter((c) => c.startsWith("!")).map((c) => c.slice(1));
  if (denied.includes(arch)) return true;
  return allowed.length > 0 && !allowed.includes(arch);
}

/** Names this platform package would have for the target CPU (`@img/sharp-linux-x64` → `…-arm64`). */
export function counterpartNames(name, fromArch, toArch) {
  const slash = name.lastIndexOf("/");
  const scope = slash >= 0 ? name.slice(0, slash + 1) : "";
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const names = new Set();
  for (const from of ARCH_TOKENS[fromArch] ?? []) {
    const re = new RegExp(`(^|[-_.])${from}(?=$|[-_.])`, "g");
    if (!re.test(base)) continue;
    for (const to of ARCH_TOKENS[toArch] ?? []) {
      names.add(scope + base.replace(new RegExp(`(^|[-_.])${from}(?=$|[-_.])`, "g"), `$1${to}`));
    }
  }
  return [...names];
}

function nodeArchOfCpuList(cpu) {
  for (const c of cpu ?? []) {
    if (c.startsWith("!")) continue;
    if (ARCH_TOKENS[c] || c === "x64" || c === "arm64") return c;
  }
  return null;
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

function danglingSymlinks(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!fs.existsSync(full)) out.push(full);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Native binaries of the bundle that belong to no package (outside every node_modules). */
export function looseNativeFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.isFile() && readNativeBinaryTarget(full)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function isElfFor(info, arch) {
  return info?.platform === "linux" && info.architectures.includes(arch);
}

function describe(info) {
  return info ? `${info.platform}/${info.architectures.join(",")}` : "unknown";
}

/**
 * @param {{standalone: string, targetRoot: string, targetArch: string, dryRun?: boolean,
 *          log?: (msg: string) => void}} options
 * @returns {{replacedPlatform: string[], replacedNative: string[], replacedLoose: string[],
 *            problems: string[]}}
 */
export function retargetStandaloneNatives({
  standalone,
  targetRoot,
  targetArch,
  dryRun = false,
  log = console.log,
}) {
  const arch = normalizeArch(targetArch);
  const targetModules = path.join(targetRoot ?? "", "node_modules");
  if (!isDir(standalone)) throw new Error(`standalone dir not found: ${standalone}`);
  if (!isDir(targetModules)) throw new Error(`target node_modules not found: ${targetModules}`);

  const targetIndex = new Map();
  for (const pkg of listPackages(targetModules, { rootIsNodeModules: true })) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!targetIndex.has(key)) targetIndex.set(key, pkg);
  }
  const findTarget = (name, version) => targetIndex.get(`${name}@${version}`) ?? null;

  const danglingBefore = new Set(danglingSymlinks(standalone));
  const replacedPlatform = [];
  const replacedNative = [];
  const replacedLoose = [];
  const problems = [];

  // Rule 1 — platform packages for another CPU.
  for (const pkg of listPackages(standalone)) {
    if (!fs.existsSync(pkg.dir) || !cpuExcludes(pkg.cpu, arch)) continue;
    const fromArch = nodeArchOfCpuList(pkg.cpu);
    const candidates = fromArch ? counterpartNames(pkg.name, fromArch, arch) : [];
    const counterpart = candidates.map((n) => findTarget(n, pkg.version)).find(Boolean);
    const rel = path.relative(standalone, pkg.dir);
    if (!counterpart) {
      problems.push(
        `platform package ${pkg.name}@${pkg.version} (${rel}) has no ${arch} counterpart in the target install (tried ${candidates.join(", ") || "none"})`
      );
      continue;
    }
    const scopeDir = pkg.name.includes("/") ? path.dirname(path.dirname(pkg.dir)) : path.dirname(pkg.dir);
    const dest = path.join(scopeDir, ...counterpart.name.split("/"));
    log(`[retarget] ${rel} -> ${path.relative(standalone, dest)} (${counterpart.name}@${counterpart.version})`);
    replacedPlatform.push(`${pkg.name} -> ${counterpart.name}`);
    if (!dryRun) {
      fs.rmSync(pkg.dir, { recursive: true, force: true });
      copyDir(counterpart.dir, dest);
    }
  }

  // Rule 2 — packages holding native binaries built for the build machine.
  for (const pkg of listPackages(standalone)) {
    if (!fs.existsSync(pkg.dir)) continue;
    if (pkg.cpu && !cpuExcludes(pkg.cpu, arch)) continue; // already a target platform package
    const natives = nativeFilesOf(pkg.dir);
    if (natives.length === 0) continue;
    const target = findTarget(pkg.name, pkg.version);
    const rel = path.relative(standalone, pkg.dir);
    const stale = natives.filter(
      (file) => !target || !sameBytes(file, path.join(target.dir, path.relative(pkg.dir, file)))
    );
    if (stale.length === 0) continue;
    if (!target) {
      problems.push(`${pkg.name}@${pkg.version} (${rel}) holds native binaries but is not in the target install`);
      continue;
    }
    replacedNative.push(pkg.name);
    // The bundle holds the traced subset of the package: swap just the binaries when the
    // target install has each at the same path, so no file the trace left out comes back.
    // A different layout (another file name per CPU) takes the target's whole package.
    const twins = stale.map((file) => path.join(target.dir, path.relative(pkg.dir, file)));
    if (twins.every((twin) => fs.existsSync(twin))) {
      log(`[retarget] ${rel}: ${stale.length} native file(s) replaced with the ${arch} build`);
      if (!dryRun) stale.forEach((file, i) => fs.copyFileSync(twins[i], file));
    } else {
      log(`[retarget] ${rel}: native layout differs, replacing package with the ${arch} install`);
      if (!dryRun) copyDir(target.dir, pkg.dir);
    }
  }

  // Rule 3 — the app's own addons, outside any package.
  for (const file of looseNativeFiles(standalone)) {
    const info = readNativeBinaryTarget(file);
    if (isElfFor(info, arch)) continue;
    const rel = path.relative(standalone, file);
    const twin = path.join(targetRoot, rel);
    if (!isElfFor(readNativeBinaryTarget(twin), arch)) {
      problems.push(`native binary ${rel} (${describe(info)}) has no ${arch} build at the same path under the target root`);
      continue;
    }
    log(`[retarget] ${rel}: replaced with the ${arch} build`);
    replacedLoose.push(rel);
    if (!dryRun) fs.copyFileSync(twin, file);
  }

  // Rule 4 — verification of the final tree.
  if (!dryRun) {
    for (const pkg of listPackages(standalone)) {
      if (cpuExcludes(pkg.cpu, arch)) {
        problems.push(`platform package for another CPU left in the bundle: ${path.relative(standalone, pkg.dir)}`);
        continue;
      }
      const target = findTarget(pkg.name, pkg.version);
      const files = nativeFilesOf(pkg.dir).map((file) => ({ file, info: readNativeBinaryTarget(file) }));
      // A binary for another CPU is legitimate only in a package that ships every platform
      // itself (it also carries the target's ELF) and only as the target install's own copy.
      const multiPlatform = files.some(({ info }) => isElfFor(info, arch));
      for (const { file, info } of files) {
        if (isElfFor(info, arch)) continue;
        const twin = target ? path.join(target.dir, path.relative(pkg.dir, file)) : null;
        if (!(multiPlatform && twin && sameBytes(file, twin))) {
          problems.push(`native binary not built for ${arch}: ${path.relative(standalone, file)} (${describe(info)})`);
        }
      }
    }
    for (const file of looseNativeFiles(standalone)) {
      const info = readNativeBinaryTarget(file);
      if (!isElfFor(info, arch)) {
        problems.push(`native binary not built for ${arch}: ${path.relative(standalone, file)} (${describe(info)})`);
      }
    }
    for (const link of danglingSymlinks(standalone)) {
      if (!danglingBefore.has(link)) problems.push(`symlink left dangling: ${path.relative(standalone, link)}`);
    }
  }

  return { replacedPlatform, replacedNative, replacedLoose, problems };
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--dry-run") args.dryRun = true;
    else if (key === "--standalone") args.standalone = argv[++i];
    else if (key === "--target-root") args.targetRoot = argv[++i];
    else if (key === "--target-arch") args.targetArch = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  for (const required of ["standalone", "targetRoot", "targetArch"]) {
    if (!args[required]) throw new Error(`missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = retargetStandaloneNatives(args);
    for (const problem of result.problems) console.error(`[retarget] ERROR ${problem}`);
    console.log(
      `[retarget] ${result.replacedPlatform.length} platform package(s), ${result.replacedNative.length} native package(s) and ${result.replacedLoose.length} app addon(s) retargeted to ${normalizeArch(args.targetArch)}`
    );
    process.exit(result.problems.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(`[retarget] ${err.message}`);
    process.exit(1);
  }
}
