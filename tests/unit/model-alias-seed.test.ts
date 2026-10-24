import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-alias-seed-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const sseModelService = await import("../../src/sse/services/model.ts");
const { DEFAULT_MODEL_ALIAS_SEED, seedDefaultModelAliases } =
  await import("../../src/lib/modelAliasSeed.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("default model alias seed writes missing aliases and is idempotent", async () => {
  const first = await seedDefaultModelAliases();
  const aliases = await modelsDb.getModelAliases();

  assert.deepEqual(first.failed, []);
  assert.equal(first.applied.length, Object.keys(DEFAULT_MODEL_ALIAS_SEED).length);
  assert.equal(aliases["gemini-3.1-flash-lite-preview"], "gemini/gemini-3.1-flash-lite");
  // Fork: no global default may move a bare name onto agy (Claude → Google account = ban risk;
  // Gemini 3.1 Pro / 3.6 Flash are retired on Antigravity).
  for (const bare of [
    "gemini-3.1-pro",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gemini-3.6-flash-low",
  ]) {
    assert.equal(aliases[bare], undefined, `${bare} must not be seeded`);
  }
  for (const target of Object.values(DEFAULT_MODEL_ALIAS_SEED)) {
    assert.ok(!String(target).startsWith("agy/"), `default seed must not target agy: ${target}`);
  }
  assert.equal(aliases["gemini-3-pro-high"], undefined);
  assert.equal(aliases["gemini-3-pro-low"], undefined);
  assert.equal(aliases["gemini-3-pro-preview"], undefined);
  assert.equal(aliases["gemini-3.1-pro-preview"], undefined);
  assert.equal(aliases["gemini-3-flash-preview"], undefined);

  for (const bare of ["claude-sonnet-4-6", "gemini-3.1-pro"]) {
    const routed = (await sseModelService.getModelInfo(bare)) as { provider?: string | null };
    assert.notEqual(routed?.provider, "antigravity", `${bare} must not route to agy/antigravity`);
    assert.notEqual(routed?.provider, "agy", `${bare} must not route to agy`);
  }

  const second = await seedDefaultModelAliases();
  assert.equal(second.applied.length, 0);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.length, Object.keys(DEFAULT_MODEL_ALIAS_SEED).length);
});

test("default model alias seed preserves existing aliases and skips invalid entries", async () => {
  await modelsDb.setModelAlias("gemini-3.1-flash-lite-preview", "custom/canonical-model");
  await modelsDb.setModelAlias("gemini-3-pro-low", "custom/legacy-model");

  const warnings = [];
  const result = await seedDefaultModelAliases({
    logger: {
      warn: (message) => warnings.push(String(message)),
    },
    seedMap: {
      ...DEFAULT_MODEL_ALIAS_SEED,
      "broken-entry": null,
    },
  });
  const aliases = await modelsDb.getModelAliases();

  assert.equal(aliases["gemini-3.1-flash-lite-preview"], "custom/canonical-model");
  assert.equal(aliases["gemini-3-pro-low"], "custom/legacy-model");
  assert.ok(result.skipped.includes("gemini-3.1-flash-lite-preview"));
  assert.equal(result.removed.includes("gemini-3-pro-low"), false);
  assert.ok(result.failed.includes("broken-entry"));
  assert.ok(warnings.some((message) => message.includes("broken-entry")));
});

test("default model alias seed removes the superseded Gemini Pro aliases (fork: no 3.1 Pro replacement)", async () => {
  await modelsDb.setModelAlias("gemini-3-pro-high", "agy/gemini-3.1-pro-high");
  await modelsDb.setModelAlias("gemini-3-pro-low", "agy/gemini-3.1-pro-low");
  await modelsDb.setModelAlias("gemini-3-pro-preview", "agy/gemini-pro-agent");
  await modelsDb.setModelAlias("gemini-3.1-pro-preview", "agy/gemini-pro-agent");

  const result = await seedDefaultModelAliases();
  const aliases = await modelsDb.getModelAliases();

  assert.deepEqual(result.removed.sort(), [
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-preview",
  ]);
  assert.equal(result.applied.includes("gemini-3.1-pro"), false);
  assert.equal(aliases["gemini-3.1-pro"], undefined);
  assert.equal(aliases["gemini-3-pro-high"], undefined);
  assert.equal(aliases["gemini-3-pro-low"], undefined);
  assert.equal(aliases["gemini-3-pro-preview"], undefined);
  assert.equal(aliases["gemini-3.1-pro-preview"], undefined);
});

test("default model alias seed removes the short-lived Pro High alias", async () => {
  await modelsDb.setModelAlias("gemini-3-pro-high", "agy/gemini-pro-agent");

  const result = await seedDefaultModelAliases();
  const aliases = await modelsDb.getModelAliases();

  assert.ok(result.removed.includes("gemini-3-pro-high"));
  assert.equal(aliases["gemini-3-pro-high"], undefined);
  assert.equal(aliases["gemini-3.1-pro"], undefined);
});

test("default model alias seed removes the retired Gemini Flash default alias", async () => {
  await modelsDb.setModelAlias("gemini-3-flash-preview", "agy/gemini-3.5-flash-medium");

  const result = await seedDefaultModelAliases();
  const aliases = await modelsDb.getModelAliases();

  assert.deepEqual(result.removed, ["gemini-3-flash-preview"]);
  assert.equal(aliases["gemini-3-flash-preview"], undefined);
});

test("default model alias seed preserves a customized retired alias", async () => {
  await modelsDb.setModelAlias("gemini-3-flash-preview", "custom/provider-model");

  const result = await seedDefaultModelAliases();
  const aliases = await modelsDb.getModelAliases();

  assert.deepEqual(result.removed, []);
  assert.equal(aliases["gemini-3-flash-preview"], "custom/provider-model");
});

test("fork: upstream's agy defaults are cleaned when an interim build seeded them", async () => {
  await modelsDb.setModelAlias("claude-sonnet-4-6", "agy/claude-sonnet-4-6");
  await modelsDb.setModelAlias("claude-opus-4-6-thinking", "agy/claude-opus-4-6-thinking");
  await modelsDb.setModelAlias("gemini-3.1-pro", "agy/gemini-pro-agent");

  const result = await seedDefaultModelAliases();
  const aliases = await modelsDb.getModelAliases();

  for (const bare of ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gemini-3.1-pro"]) {
    assert.ok(result.removed.includes(bare), `${bare} must be removed`);
    assert.equal(aliases[bare], undefined);
  }
});
