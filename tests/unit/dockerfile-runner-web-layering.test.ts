/**
 * The Chromium install of the `runner-web` image sits BELOW the app layers.
 *
 * Stacked on `runner-base` it reran on every build (108 apt packages + the browser
 * download, ~2 min under QEMU for arm64) because any code change changes the layers
 * beneath it. `web-browsers` depends only on `base` and on the CONTENT of the Playwright
 * package (bind-mounted from the `playwright-cli` scratch stage), so a code-only rebuild
 * reuses it. The price: `runner-web` cannot derive from `runner-base`, so it repeats
 * runner-base's instructions after its own FROM. This test keeps that copy honest: a
 * change to runner-base (an ENV, a COPY, the HEALTHCHECK, the smoke test) must be made in
 * runner-web too, or the web image silently diverges from the lean one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");

type Stage = { name: string; base: string; instructions: string[] };

/** Split the Dockerfile into stages; continuations joined, comments dropped. */
function parseStages(source: string): Stage[] {
  const lines = source
    .replace(/\\\r?\n\s*/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const stages: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      stages.push({ name: from[2] ?? `stage${stages.length}`, base: from[1], instructions: [] });
    } else if (stages.length > 0) {
      stages[stages.length - 1].instructions.push(line);
    }
  }
  return stages;
}

const stages = parseStages(dockerfile);
const stage = (name: string): Stage => {
  const found = stages.find((s) => s.name === name);
  assert.ok(found, `Dockerfile has no "${name}" stage`);
  return found;
};
const order = (name: string) => stages.findIndex((s) => s.name === name);

test("runner-web derives from web-browsers, not from runner-base", () => {
  assert.equal(stage("runner-web").base, "web-browsers");
  assert.notEqual(stage("runner-web").base, "runner-base");
});

test("web-browsers derives from base and does not depend on the app build", () => {
  const web = stage("web-browsers");
  assert.equal(web.base, "base");
  for (const instruction of web.instructions) {
    assert.doesNotMatch(
      instruction,
      /--from=(builder|runner-base|target-natives)\b/,
      `web-browsers must not depend on the app build (it would rerun on every code change): ${instruction}`
    );
  }
});

test("web-browsers installs chromium with OS deps and xvfb, from the bind-mounted Playwright CLI", () => {
  const install = stage("web-browsers").instructions.find((i) => i.startsWith("RUN"));
  assert.ok(install, "web-browsers must have a RUN install step");
  // Mounted over /app so Playwright's `.links` registry records /app/node_modules/playwright-core,
  // the path the runtime uses (not a directory that is absent from the image).
  assert.match(install, /--mount=type=bind,from=playwright-cli,source=\/,target=\/app /);
  assert.match(install, /node node_modules\/playwright\/cli\.js install chromium --with-deps/);
  assert.match(install, /apt-get install -y --no-install-recommends xvfb/);
  assert.match(install, /chown -R node:node \/home\/node\/\.cache/);
  assert.ok(
    stage("web-browsers").instructions.includes("ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright"),
    "the browsers path must be set in web-browsers so runner-web inherits it"
  );
});

test("playwright-cli is a scratch stage with only the two Playwright packages from the builder", () => {
  const cli = stage("playwright-cli");
  assert.equal(cli.base, "scratch");
  assert.deepEqual(cli.instructions, [
    "COPY --from=builder /app/node_modules/playwright-core /node_modules/playwright-core",
    "COPY --from=builder /app/node_modules/playwright /node_modules/playwright",
  ]);
});

test("stages are declared before use (BuildKit requires it)", () => {
  assert.ok(order("builder") < order("playwright-cli"));
  assert.ok(order("playwright-cli") < order("web-browsers"));
  assert.ok(order("web-browsers") < order("runner-web"));
});

test("runner-web repeats every runner-base instruction, in the same order", () => {
  const base = stage("runner-base").instructions;
  const web = stage("runner-web").instructions;
  let at = 0;
  for (const instruction of base) {
    const found = web.indexOf(instruction, at);
    assert.notEqual(
      found,
      -1,
      `runner-web is missing (or reorders) this runner-base instruction — change both stages:\n  ${instruction}`
    );
    at = found + 1;
  }
});

test("runner-web adds only the Playwright overlay on top of runner-base's instructions", () => {
  const base = new Set(stage("runner-base").instructions);
  const extras = stage("runner-web").instructions.filter((i) => !base.has(i));
  assert.deepEqual(extras, [
    "USER root",
    "COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core",
    "COPY --from=builder /app/node_modules/playwright ./node_modules/playwright",
  ]);
  // The overlay is root-owned, as before the restructure, and the image still runs as node.
  const web = stage("runner-web").instructions;
  assert.ok(
    web.lastIndexOf("USER root") > web.indexOf('CMD ["node", "dev/run-standalone.mjs"]'),
    "USER root comes after runner-base's instructions, only for the overlay COPYs"
  );
  assert.equal(web[web.length - 1], "USER node", "the runtime must not stay root");
});

test("runner-cli still derives from runner-base (the lean image is untouched)", () => {
  assert.equal(stage("runner-cli").base, "runner-base");
  assert.equal(stage("runner-base").base, "base");
});
