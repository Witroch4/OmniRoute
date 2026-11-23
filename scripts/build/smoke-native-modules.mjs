#!/usr/bin/env node
/**
 * smoke-native-modules.mjs — load every native module of the assembled app on the image's
 * own CPU. Run by the Dockerfile inside `runner-base` (under QEMU when the image is built
 * for another architecture), from the app root, so a binary compiled or downloaded for the
 * wrong CPU fails the image build instead of the first request in production.
 *
 * better-sqlite3 and wreq-js are required (the app cannot boot without them); the others
 * are checked when the bundle carries them.
 *
 * Usage: node smoke-native-modules.mjs [appRoot]   (default: cwd)
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(process.argv[2] || process.cwd());
const require = createRequire(path.join(appRoot, "package.json"));
const results = [];
let failed = false;

async function check(name, required, fn) {
  let resolved;
  try {
    resolved = require.resolve(name);
  } catch {
    if (required) {
      failed = true;
      results.push(`FAIL ${name}: not resolvable from ${appRoot}`);
    } else {
      results.push(`skip ${name}: not in the bundle`);
    }
    return;
  }
  try {
    const detail = await fn(resolved);
    results.push(`ok   ${name}${detail ? ` (${detail})` : ""}`);
  } catch (err) {
    failed = true;
    results.push(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

await check("better-sqlite3", true, () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  const row = db.prepare("select sqlite_version() as v").get();
  db.close();
  return `sqlite ${row.v}`;
});

await check("wreq-js", true, () => {
  const wreq = require("wreq-js");
  if (typeof wreq.createTransport !== "function") throw new Error("createTransport missing");
  return "createTransport";
});

await check("sqlite-vec", false, () => {
  const sqliteVec = require("sqlite-vec");
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  sqliteVec.load(db);
  const row = db.prepare("select vec_version() as v").get();
  db.close();
  return `vec ${row.v}`;
});

await check("sharp", false, async () => {
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } })
    .png()
    .toBuffer();
  return `png ${png.length} bytes`;
});

await check("onnxruntime-node", false, async (resolved) => {
  const ort = await import(pathToFileURL(resolved).href);
  const api = ort.default ?? ort;
  if (typeof api.InferenceSession?.create !== "function") throw new Error("InferenceSession missing");
  return "InferenceSession";
});

await check("esbuild", false, () => {
  const esbuild = require("esbuild");
  const out = esbuild.transformSync("let a: number = 1", { loader: "ts" });
  return `transform ${out.code.trim()}`;
});

await check("@ngrok/ngrok", false, () => {
  const ngrok = require("@ngrok/ngrok");
  if (typeof ngrok.forward !== "function") throw new Error("forward missing");
  return "forward";
});

// The app's own TPROXY addon (built by `npm run build`, copied outside node_modules).
const tproxyAddon = path.join(appRoot, "src/mitm/tproxy/native/build/Release/transparent.node");
if (existsSync(tproxyAddon)) {
  try {
    const addon = require(tproxyAddon);
    results.push(`ok   tproxy transparent.node (${Object.keys(addon).join(",") || "loaded"})`);
  } catch (err) {
    failed = true;
    results.push(`FAIL tproxy transparent.node: ${err?.message ?? err}`);
  }
} else {
  results.push("skip tproxy transparent.node: not in the bundle");
}

console.log(`[smoke-native] ${process.platform}/${process.arch} node ${process.version} in ${appRoot}`);
for (const line of results) console.log(`[smoke-native] ${line}`);
process.exit(failed ? 1 : 0);
