// Per-model output ceiling for the shared Antigravity Cloud Code executor
// (used by BOTH the `antigravity` and `agy` providers).
//
// History — why this replaced a blanket cap:
//
// decolua/9router#779 introduced a single hard ceiling of 16384 on
// `generationConfig.maxOutputTokens`, because VS Code GitHub Copilot Chat in
// Agent mode routinely requests 32K–65K and the Antigravity backend answered
// HTTP 400 "Invalid Argument". That cap was a blunt instrument: it applied to
// every model on the provider, so a model whose real ceiling is 65536 was
// silently shrunk to a quarter of its capacity.
//
// The cost of that is not just a smaller answer. On a reasoning model the
// thinking tokens and the visible answer share the same output budget, so a
// 16384 cap can be consumed almost entirely by reasoning — measured in
// production on `agy/gemini-3.7-flash-low`: 15731 reasoning tokens against 588
// visible ones, the JSON answer truncated mid-document. The client had asked
// for 48000.
//
// Verified against the live `:fetchAvailableModels` probe and by a direct 200
// OK / `finishReason=STOP` run at 48000 output tokens on the same connection:
// the backend accepts far more than 16384. The catalogs pinned from that probe
// (`agyModels.ts`, `antigravityModelAliases.ts`) already carry each model's own
// `maxOutputTokens`, so the ceiling is now read from there.
//
// Unknown / passthrough models (the `agy` provider runs with
// `passthroughModels: true`, so a freshly-released model reaches the executor
// before anyone pins it) fall back to DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS rather
// than to the old 16384 — otherwise the very models that motivated this change
// would keep the legacy cap.

import { AGY_PUBLIC_MODELS } from "./agyModels.ts";
import {
  ANTIGRAVITY_PUBLIC_MODELS,
  resolveAntigravityModelId,
  toClientAntigravityModelId,
} from "./antigravityModelAliases.ts";

/**
 * Ceiling applied when the model carries no pinned `maxOutputTokens`.
 *
 * 65536 is the highest value the pinned catalogs advertise and was confirmed
 * live on the Cloud Code backend. A model that genuinely accepts less is
 * expected to say so in its catalog entry (e.g. `gpt-oss-120b-medium`, 32768).
 */
export const DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS = 65536;

type CatalogEntry = { readonly id: string; readonly maxOutputTokens?: number };

function collectLimits(): Readonly<Record<string, number>> {
  const limits: Record<string, number> = {};

  const register = (id: string, max: number): void => {
    if (!id) return;
    // First writer wins so a catalog cannot be silently overridden by a later
    // one; the two lists agree on every shared id today.
    if (limits[id] === undefined) limits[id] = max;
  };

  for (const catalog of [
    ANTIGRAVITY_PUBLIC_MODELS,
    AGY_PUBLIC_MODELS,
  ] as readonly (readonly CatalogEntry[])[]) {
    for (const model of catalog) {
      const max = Number(model.maxOutputTokens);
      if (!Number.isFinite(max) || max <= 0) continue;
      // Index under the public id AND the upstream id it resolves to, because
      // the executor caps the request after `cleanModelName()` has already
      // mapped the public name onto the legacy upstream one.
      register(model.id, max);
      register(resolveAntigravityModelId(model.id), max);
    }
  }

  return Object.freeze(limits);
}

const CATALOG_OUTPUT_LIMITS = collectLimits();

/**
 * Resolve the output ceiling for a model on the Antigravity Cloud Code backend.
 *
 * Accepts a public id (`gemini-3.6-flash-low`), an upstream id, or a
 * provider-prefixed one (`agy/gemini-3.6-flash-low`). Returns
 * DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS when the model is not pinned in either
 * catalog.
 */
export function resolveAntigravityMaxOutputTokens(modelId: string | undefined | null): number {
  if (!modelId) return DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS;

  const stripped = modelId.includes("/") ? modelId.split("/").pop()! : modelId;

  for (const candidate of [stripped, toClientAntigravityModelId(stripped)]) {
    const limit = candidate ? CATALOG_OUTPUT_LIMITS[candidate] : undefined;
    if (limit !== undefined) return limit;
  }

  return DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS;
}

// Test-only export: lets the unit suite assert the pinned table without
// re-deriving it from the catalogs.
export const __test_CATALOG_OUTPUT_LIMITS = CATALOG_OUTPUT_LIMITS;
