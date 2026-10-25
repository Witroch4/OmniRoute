/**
 * Fork — the live-catalog gate must accept the Claude effort variants the catalog itself
 * publishes (`appendClaudeEffortVariants`: low/medium/high, xhigh only where supported).
 *
 * Measured in production on 2026-10-25: `/v1/models` listed `gh/claude-haiku-5.5-{low,medium,high}`,
 * `gh/claude-haiku-4.5-*`, `opencode-go/claude-haiku-5-5-*` and `amazon-q/claude-sonnet-4.5-*`,
 * and every one of them answered `400 Model '…' is not available in the active live catalog`
 * before any upstream call. The Sonnet variants on the same Copilot connection worked only
 * because their registry entries happen to declare `supportedThinkingEfforts`; the catalog
 * advertises Claude variants from `modelSpecs.supportsThinking`, so the two disagreed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-effort-gate-"));

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "claude-effort-gate-test-secret";

const core = await import("../../src/lib/db/core.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");

function seedProviderCatalog(providerId: string, connectionId: string, modelIds: string[]) {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO provider_connections
       (id, provider, is_active, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`
  ).run(connectionId, providerId, now, now);
  return replaceSyncedAvailableModelsForConnection(
    providerId,
    connectionId,
    modelIds.map((id) => ({ id, name: id, source: "imported" as const }))
  );
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Copilot Haiku 5.5 effort variants published by the catalog pass the live gate", async () => {
  await seedProviderCatalog("github", "gh-haiku-live", ["claude-haiku-5.5", "claude-haiku-4.5"]);

  for (const level of ["low", "medium", "high"]) {
    const info = await getModelInfo(`gh/claude-haiku-5.5-${level}`);
    assert.equal(info.errorType, undefined, `${level}: ${info.errorMessage}`);
    assert.equal(info.provider, "github");
    // The suffix stays on the id: chatCore's applyClaudeEffortVariant turns it into
    // reasoning_effort before translation, exactly as on providers without a live catalog.
    assert.equal(info.model, `claude-haiku-5.5-${level}`);
  }

  const older = await getModelInfo("gh/claude-haiku-4.5-low");
  assert.equal(older.errorType, undefined, older.errorMessage);
  assert.equal(older.provider, "github");
});

test("a Claude tier the catalog does not advertise stays refused", async () => {
  await seedProviderCatalog("github", "gh-haiku-live", ["claude-haiku-5.5"]);

  // Haiku has no extra-high effort (supportsXHighEffort false), so no `-xhigh` is published.
  const xhigh = await getModelInfo("gh/claude-haiku-5.5-xhigh");
  assert.equal(xhigh.provider, null);
  assert.equal(xhigh.errorType, "model_not_found");
});

test("a Claude effort variant whose base is absent from the live catalog stays refused", async () => {
  await seedProviderCatalog("github", "gh-no-haiku", ["gpt-5.6-sol"]);

  const info = await getModelInfo("gh/claude-haiku-5.5-medium");
  assert.equal(info.provider, null);
  assert.equal(info.errorType, "model_not_found");
  assert.match(info.errorMessage, /active live catalog/i);
});

test("OpenCode Go Haiku 5.5 effort variants pass the live gate", async () => {
  await seedProviderCatalog("opencode-go", "go-haiku-live", ["claude-haiku-5-5", "glm-5.3-flash"]);

  const info = await getModelInfo("opencode-go/claude-haiku-5-5-medium");
  assert.equal(info.errorType, undefined, info.errorMessage);
  assert.equal(info.provider, "opencode-go");
  assert.equal(info.model, "claude-haiku-5-5-medium");
});

test("a non-Claude id with an effort-like suffix is not admitted by the Claude rule", async () => {
  await seedProviderCatalog("opencode-go", "go-glm-live", ["glm-5.3-flash"]);

  const info = await getModelInfo("opencode-go/glm-5.3-flash-medium");
  assert.equal(info.provider, null);
  assert.equal(info.errorType, "model_not_found");
});
