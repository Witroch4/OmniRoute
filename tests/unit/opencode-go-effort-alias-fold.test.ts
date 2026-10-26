/**
 * Fork — OpenCode Go effort-tier aliases fold onto their base model.
 *
 * The Go registry lists `<base>-<tier>` aliases as their own ids (upstream #10788/#12674, from
 * the v1 era when `opencode models opencode-go --verbose` listed them). The Go v2 backend does
 * not serve them: measured 2026-10-25, every call to `muse-spark-1.{2,3}-contributor-*`,
 * `glm-5.2-{high,max}`, `hy3-{low,high}`, `kimi-k3-max`, `mimo-v2.5-{high,max}` and
 * `qwen3.7-plus-{high,max}` answered `400 Model is unavailable` and armed a 30-minute lockout,
 * while `/v1/models` kept publishing them. The base ids honour `reasoning_effort` (Muse Spark:
 * 159 → 869 → 1128 reasoning tokens for minimal → medium → xhigh), so the alias now resolves to
 * base + effort before dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-go-effort-fold-"));

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "go-effort-fold-test-secret";

const core = await import("../../src/lib/db/core.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");

type GoModel = {
  id: string;
  supportedThinkingEfforts?: readonly string[];
  effortSuffixesThatFoldDespiteLiveCatalog?: readonly string[];
};

const GO_MODELS = (REGISTRY["opencode-go"]?.models ?? []) as GoModel[];

function seedLiveCatalog(modelIds: string[]) {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO provider_connections
       (id, provider, is_active, created_at, updated_at)
     VALUES ('go-live', 'opencode-go', 1, ?, ?)`
  ).run(now, now);
  return replaceSyncedAvailableModelsForConnection(
    "opencode-go",
    "go-live",
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

const CASES: Array<[alias: string, base: string, effort: string]> = [
  ["muse-spark-1.3-contributor-minimal", "muse-spark-1.3-contributor", "minimal"],
  ["muse-spark-1.3-contributor-medium", "muse-spark-1.3-contributor", "medium"],
  ["muse-spark-1.3-contributor-xhigh", "muse-spark-1.3-contributor", "xhigh"],
  ["muse-spark-1.2-contributor-low", "muse-spark-1.2-contributor", "low"],
  ["glm-5.2-high", "glm-5.2", "high"],
  ["glm-5.2-max", "glm-5.2", "max"],
  ["hy3-low", "hy3", "low"],
  ["hy3-high", "hy3", "high"],
  ["kimi-k3-max", "kimi-k3", "max"],
  ["mimo-v2.5-high", "mimo-v2.5", "high"],
  ["mimo-v2.5-max", "mimo-v2.5", "max"],
  ["qwen3.7-plus-high", "qwen3.7-plus", "high"],
  ["qwen3.7-plus-max", "qwen3.7-plus", "max"],
];

for (const [alias, base, effort] of CASES) {
  test(`opencode-go/${alias} resolves to ${base} with effort ${effort}`, async () => {
    await seedLiveCatalog([base]);
    const info = await getModelInfo(`opencode-go/${alias}`);
    assert.equal(info.errorType, undefined, info.errorMessage);
    assert.equal(info.provider, "opencode-go");
    assert.equal(info.model, base);
    assert.equal(info.resolvedThinkingEffort, effort);
  });
}

test("the base id keeps resolving untouched, with no folded effort", async () => {
  await seedLiveCatalog(["muse-spark-1.3-contributor"]);
  const info = await getModelInfo("opencode-go/muse-spark-1.3-contributor");
  assert.equal(info.model, "muse-spark-1.3-contributor");
  assert.equal(info.resolvedThinkingEffort, undefined);
});

test("a tier the base does not declare is not folded", async () => {
  await seedLiveCatalog(["glm-5.2"]);
  // glm-5.2 declares high/max only.
  const info = await getModelInfo("opencode-go/glm-5.2-low");
  assert.equal(info.provider, null);
  assert.equal(info.errorType, "model_not_found");
});

test("every explicit Go effort alias in the registry folds onto its base", () => {
  const byId = new Map(GO_MODELS.map((model) => [model.id, model]));
  // deepseek-v4-pro aliases are folded by the executor and already served; the rest of the
  // aliases the v2 backend does not serve must fold at the gate.
  const alreadyServed = new Set(["deepseek-v4-pro"]);
  const unfolded: string[] = [];
  for (const model of GO_MODELS) {
    const match = /^(.*)-(none|minimal|low|medium|high|xhigh|max)$/.exec(model.id);
    if (!match) continue;
    const [, baseId, effort] = match;
    const base = byId.get(baseId);
    if (!base || alreadyServed.has(baseId)) continue;
    if (!base.supportedThinkingEfforts?.includes(effort)) continue;
    if (!base.effortSuffixesThatFoldDespiteLiveCatalog?.includes(effort)) unfolded.push(model.id);
  }
  assert.deepEqual(
    unfolded,
    [],
    "alias ids published by the registry that the Go backend answers 400 for"
  );
});
