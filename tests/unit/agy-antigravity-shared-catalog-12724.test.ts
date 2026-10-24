// #12724 — agy and antigravity catalogs must be derived from the shared base
// and stay identical until a per-surface delta is introduced.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_SHARED_MODELS,
  buildSurfaceCatalog,
} from "../../open-sse/config/antigravitySharedModels.ts";
import { AGY_PUBLIC_MODELS } from "../../open-sse/config/agyModels.ts";
import { ANTIGRAVITY_PUBLIC_MODELS } from "../../open-sse/config/antigravityModelAliases.ts";

const serial = { concurrency: false };

// Fork: the agy and antigravity catalogs stay explicit, curated lists (agyModels.ts,
// antigravityModelAliases.ts) — they legitimately differ (agy carries the Gemini 3.1 Flash
// Image model, antigravity carries Computer Use and the Gemini 3 Pro image preview), so they
// are NOT derived from the shared base. The shared base is the curated common subset; these
// tests pin that it stays common, curated and in sync with both surfaces.
const BASE_SIZE = ANTIGRAVITY_SHARED_MODELS.length;

test("#12724 — shared base is non-empty with unique ids", serial, () => {
  assert.ok(BASE_SIZE >= 9);
  assert.equal(new Set(ANTIGRAVITY_SHARED_MODELS.map((m) => m.id)).size, BASE_SIZE);
  for (const id of ["gemini-3.7-flash-high", "gemini-3.7-flash-medium"]) {
    assert.ok(!ANTIGRAVITY_SHARED_MODELS.some((m) => m.id === id), `${id} must stay retired`);
  }
});

test("#12724 — every shared model is published by both surfaces", serial, () => {
  const agyIds = new Set(AGY_PUBLIC_MODELS.map((m) => m.id));
  const antigravityIds = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((m) => m.id));
  for (const { id } of ANTIGRAVITY_SHARED_MODELS) {
    assert.ok(agyIds.has(id), `agy must publish shared model ${id}`);
    assert.ok(antigravityIds.has(id), `antigravity must publish shared model ${id}`);
  }
});

test(
  "#12724 — the shared base keeps the fork invariants (no retired, no -tiered, no Argon)",
  serial,
  () => {
    for (const { id } of ANTIGRAVITY_SHARED_MODELS) {
      assert.ok(!id.endsWith("-tiered"), `${id}: tiers are real ids, never -tiered`);
      assert.ok(!id.includes("argon"), `${id}: no Argon in the static catalog`);
      assert.ok(
        !["gemini-pro-agent", "gemini-3.1-pro-low", "gemini-3.1-pro-high"].includes(id),
        `${id} is retired`
      );
      assert.ok(!/^claude-(opus|sonnet)-4-6/.test(id), `${id}: Claude 4.6 is retired`);
    }
  }
);

test("#12724 — buildSurfaceCatalog remove delta works", serial, () => {
  const subset = buildSurfaceCatalog(ANTIGRAVITY_SHARED_MODELS, {
    remove: ["gemini-3.8-flash-high"],
  });
  assert.equal(subset.length, BASE_SIZE - 1);
  assert.ok(!subset.some((m) => m.id === "gemini-3.8-flash-high"));
});

test("#12724 — buildSurfaceCatalog add delta works", serial, () => {
  const extended = buildSurfaceCatalog(ANTIGRAVITY_SHARED_MODELS, {
    add: [{ id: "custom-model-v1", name: "Custom Model" }],
  });
  assert.equal(extended.length, BASE_SIZE + 1);
  assert.ok(extended.some((m) => m.id === "custom-model-v1"));
});

test("#12724 — buildSurfaceCatalog with both add and remove", serial, () => {
  const mixed = buildSurfaceCatalog(ANTIGRAVITY_SHARED_MODELS, {
    add: [{ id: "custom-model-v1", name: "Custom Model" }],
    remove: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"],
  });
  assert.equal(mixed.length, BASE_SIZE - 2 + 1);
  assert.ok(!mixed.some((m) => m.id === "gemini-3.8-flash-high"));
  assert.ok(mixed.some((m) => m.id === "custom-model-v1"));
});

test("#12724 — buildSurfaceCatalog returns frozen array", serial, () => {
  const result = buildSurfaceCatalog(ANTIGRAVITY_SHARED_MODELS);
  assert.ok(Object.isFrozen(result));
});
