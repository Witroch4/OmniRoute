import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

// Regression: on WSL the healthcheck ran the Windows editor launcher found on PATH
// (`/mnt/c/.../cursor/resources/app/bin/cursor`) with a stripped environment. Those
// launchers are `sh` scripts that need WSL_DISTRO_NAME; without it they fall through to
// `Cursor.exe <cli.js> -v` with no ELECTRON_RUN_AS_NODE crossing the interop boundary, so
// every probe opened the Cursor GUI on the user's Windows desktop.

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const modulePath = path.join(process.cwd(), "src/shared/services/cliRuntime.ts");

const originalSpawn = childProcess.spawn;
const originalEnv = { ...process.env };
const tempDirs = new Set<string>();

type SpawnCall = { command: string; args: string[] };

async function importFresh(label: string) {
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}-${Math.random()}`);
}

function createTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function writeLauncher(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\necho 1.2.3\n# padding padding padding padding padding\n");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function installRecordingSpawn(calls: SpawnCall[]) {
  childProcess.spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("1.2.3\n"));
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();
}

test.afterEach(() => {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("isWindowsLauncherUnderWsl flags non-.exe files on a Windows drive mount, only inside WSL", async () => {
  const { isWindowsLauncherUnderWsl } = await importFresh("helper");
  const wsl = { isWsl: true, mountRoot: "/mnt" };
  const notWsl = { isWsl: false, mountRoot: "/mnt" };

  const cursorShim = "/mnt/c/Users/me/AppData/Local/Programs/cursor/resources/app/bin/cursor";
  assert.equal(isWindowsLauncherUnderWsl(cursorShim, wsl), true);
  assert.equal(isWindowsLauncherUnderWsl("/mnt/d/tools/code", wsl), true);

  // Real Windows programs obey their arguments; only the launcher scripts are the problem.
  assert.equal(isWindowsLauncherUnderWsl("/mnt/c/Program Files/nodejs/node.exe", wsl), false);
  // Linux-side binaries and look-alike paths are untouched.
  assert.equal(isWindowsLauncherUnderWsl("/usr/local/bin/cursor", wsl), false);
  assert.equal(isWindowsLauncherUnderWsl("/home/me/mnt/c/cursor", wsl), false);
  assert.equal(isWindowsLauncherUnderWsl("/mnt/wslg/runtime-dir/cursor", wsl), false);
  // Outside WSL, /mnt/c is just another directory.
  assert.equal(isWindowsLauncherUnderWsl(cursorShim, notWsl), false);
});

test("healthcheck never executes a Windows editor launcher under WSL", async () => {
  const root = createTempDir("omniroute-wsl-mnt-");
  const launcher = writeLauncher(path.join(root, "mnt/c/cursor/resources/app/bin/cursor"));
  const calls: SpawnCall[] = [];
  installRecordingSpawn(calls);
  process.env.CLI_CURSOR_BIN = launcher;

  const cliRuntime = await importFresh("skip-under-wsl");
  cliRuntime.__setWslContextForTests({ isWsl: true, mountRoot: path.join(root, "mnt") });
  const status = await cliRuntime.getCliRuntimeStatus("cursor");

  assert.deepEqual(
    calls.filter((call) => call.command === launcher),
    [],
    "the launcher must not be spawned: that is what opened the Cursor window"
  );
  assert.equal(status.installed, true);
  assert.equal(status.runnable, false);
  assert.equal(status.reason, "windows_launcher_skipped");
});

test("healthcheck still runs the same launcher when not under WSL", async () => {
  const root = createTempDir("omniroute-not-wsl-mnt-");
  const launcher = writeLauncher(path.join(root, "mnt/c/cursor/resources/app/bin/cursor"));
  const calls: SpawnCall[] = [];
  installRecordingSpawn(calls);
  process.env.CLI_CURSOR_BIN = launcher;

  const cliRuntime = await importFresh("run-outside-wsl");
  cliRuntime.__setWslContextForTests({ isWsl: false, mountRoot: path.join(root, "mnt") });
  const status = await cliRuntime.getCliRuntimeStatus("cursor");

  assert.equal(calls.filter((call) => call.command === launcher).length, 1);
  assert.equal(status.runnable, true);
  assert.equal(status.reason, null);
});
