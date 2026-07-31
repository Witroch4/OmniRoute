/**
 * Shared model-pricing resolution — the single place that answers
 * "what does (provider, model) cost per MTok?".
 *
 * Before this module, three surfaces resolved pricing independently and
 * disagreed by orders of magnitude whenever a model was missing from the
 * catalog (issue: `claude-opus-5` shipped without a pricing row):
 *
 *   - `getPricingForModel` (provider-window cost modal, API-key USD quota,
 *     `domain_cost_history` writes) did an exact lookup only → `null` → $0.
 *     95% of a week's traffic was billed as free, so the USD quota never
 *     tripped and `@@om-usage` reported "99% left".
 *   - the cost dashboard walked a fallback chain that ended at
 *     `Object.keys(providerPricing)[0]` — the FIRST model of the provider,
 *     which for `cc` is `claude-fable-5` at exactly 2x Opus rates. A missing
 *     model was silently priced as an unrelated (and pricier) one.
 *
 * The rules here are deliberately narrow: match the same model by name, and
 * fall back to a family anchor ONLY for Claude, whose tiers have stable
 * per-tier pricing (every `claude-opus-*` bills at Opus rates). Any other
 * provider with no row resolves to `null` and is reported, so a new Gemini or
 * GPT id surfaces as a visible gap instead of a plausible wrong number.
 *
 * @module lib/usage/pricingResolution
 */

import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { normalizeModelName } from "./costCalculator";

export type PricingRecord = Record<string, unknown>;
export type PricingModels = Record<string, PricingRecord>;
export type PricingByProvider = Record<string, PricingModels>;

/**
 * How a pricing row was found. `family_anchor` means the exact model had no
 * row and Claude tier pricing was applied — accurate for Claude, but worth
 * surfacing so a genuinely new tier still gets a real row eventually.
 */
export type PricingMatchSource = "exact" | "cross_provider" | "family_anchor" | "missing";

export interface PricingResolution {
  pricing: PricingRecord | null;
  source: PricingMatchSource;
  /** Catalog key the row came from (`cc`, `ag`, …). Null when unresolved. */
  matchedProvider: string | null;
  /** Catalog model key the row came from. Null when unresolved. */
  matchedModel: string | null;
}

const MISSING: PricingResolution = {
  pricing: null,
  source: "missing",
  matchedProvider: null,
  matchedModel: null,
};

/**
 * Claude tier anchors. Each `claude-<tier>-*` id bills at its tier's rates, so
 * a not-yet-cataloged id (e.g. `claude-opus-5` on release day) can borrow the
 * anchor's row and be off by nothing rather than off by 2x or by 100%.
 *
 * Anchors are ids that must exist in the catalog; if one is ever removed the
 * lookup simply falls through to `missing` (no silent mispricing).
 */
const CLAUDE_FAMILY_ANCHORS: ReadonlyArray<{ pattern: RegExp; anchor: string }> = [
  // Fable/Mythos first: they are Claude ids but priced above the Opus tier, so
  // they must not be caught by a looser rule.
  { pattern: /^claude-(?:fable|mythos)\b/, anchor: "claude-fable-5" },
  { pattern: /^claude-opus\b/, anchor: "claude-opus-4-8" },
  { pattern: /^claude-sonnet\b/, anchor: "claude-sonnet-5" },
  { pattern: /^claude-haiku\b/, anchor: "claude-haiku-4-5-20251001" },
];

function findKeyInsensitive<T>(
  obj: Record<string, T> | undefined | null,
  key: string
): T | undefined {
  if (!obj || !key) return undefined;
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerKey) return v;
  }
  return undefined;
}

function uniqueLowered(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Drop a trailing reasoning-effort suffix (`gpt-5.5-medium` → `gpt-5.5`).
 * Covers every level the effort parameter accepts, plus the Codex-only
 * `ultra`, so both the Codex and analytics call sites share one behavior.
 */
export function stripEffortSuffix(model: string): string {
  return model.replace(/-(?:ultra|max|xhigh|high|medium|low|none)$/i, "");
}

/**
 * Catalog keys to try for a model id, most specific first. Covers the
 * `.`/`-` spelling split (`gemini-3.1-pro` vs `gemini-3-1-pro`) and the
 * effort suffix.
 */
export function getPricingModelCandidates(model: string): string[] {
  const lowerModel = (model || "").toLowerCase();
  const lowerNormalized = normalizeModelName(lowerModel);
  const effortBase = stripEffortSuffix(lowerNormalized);

  return uniqueLowered([
    lowerModel,
    lowerNormalized,
    lowerModel.replace(/\./g, "-"),
    lowerNormalized.replace(/\./g, "-"),
    effortBase,
    effortBase.replace(/\./g, "-"),
    // `codex-auto-review` is a Codex-internal label billed at gpt-5.5 rates.
    lowerNormalized === "codex-auto-review" ? "gpt-5.5" : null,
  ]);
}

/**
 * Catalog keys to try for a provider id, covering the id↔alias split
 * (`codex`↔`cx`), the regional `-cn` variants, and the `antigravity`→`ag`
 * rename.
 */
export function getPricingProviderCandidates(provider: string): string[] {
  const pLower = (provider || "").trim().toLowerCase();
  if (!pLower) return [];

  const candidates: Array<string | null> = [pLower, PROVIDER_ID_TO_ALIAS[pLower] ?? null];

  // pLower may itself be the alias — walk the map backwards for the raw id.
  for (const [id, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
    if (typeof alias === "string" && alias.toLowerCase() === pLower) candidates.push(id);
  }

  const withoutRegion = pLower.replace(/-cn$/, "");
  if (withoutRegion !== pLower) candidates.push(withoutRegion);
  if (pLower === "antigravity") candidates.push("ag");

  return uniqueLowered(candidates);
}

function lookupInProvider(
  models: PricingModels | undefined,
  candidates: string[]
): { pricing: PricingRecord; matchedModel: string } | null {
  if (!models || typeof models !== "object") return null;
  for (const candidate of candidates) {
    const pricing = findKeyInsensitive<PricingRecord>(models, candidate);
    if (pricing) return { pricing, matchedModel: candidate };
  }
  return null;
}

/**
 * Resolve pricing for a (provider, model) pair against a merged catalog.
 *
 * Resolution order — each step only ever returns the price of the SAME model,
 * except the last, which is restricted to Claude tiers:
 *
 *   1. the model, in its own provider's catalog;
 *   2. the model, in any other provider's catalog (same id ⇒ same rates —
 *      this is how `claude-sonnet-5` served via `amazon-q`/`github` gets
 *      priced, since those providers carry no Claude rows of their own);
 *   3. for Claude ids only, the tier anchor (`claude-opus-*` → Opus rates).
 *
 * Anything else resolves to `missing`. Callers decide how loudly to report it
 * (see {@link reportMissingPricing}); nothing is ever priced as a different
 * model.
 */
export function resolveModelPricing(
  pricingByProvider: PricingByProvider,
  provider: string,
  model: string
): PricingResolution {
  if (!pricingByProvider || !model) return MISSING;

  const modelCandidates = getPricingModelCandidates(model);
  if (modelCandidates.length === 0) return MISSING;

  // 1. The model in its own provider's catalog.
  for (const providerKey of getPricingProviderCandidates(provider)) {
    const models = findKeyInsensitive<PricingModels>(pricingByProvider, providerKey);
    const hit = lookupInProvider(models, modelCandidates);
    if (hit) {
      return {
        pricing: hit.pricing,
        source: "exact",
        matchedProvider: providerKey,
        matchedModel: hit.matchedModel,
      };
    }
  }

  // 2. The same model id under a different provider. Safe: keyed on the model
  //    name, so the rates belong to the model actually being billed.
  for (const [providerKey, models] of Object.entries(pricingByProvider)) {
    const hit = lookupInProvider(models, modelCandidates);
    if (hit) {
      return {
        pricing: hit.pricing,
        source: "cross_provider",
        matchedProvider: providerKey,
        matchedModel: hit.matchedModel,
      };
    }
  }

  // 3. Claude tier anchor — the only fallback that resolves to a different
  //    model id, and only where per-tier rates are uniform by construction.
  const familyKey = modelCandidates.find((candidate) => candidate.startsWith("claude-"));
  if (familyKey) {
    const entry = CLAUDE_FAMILY_ANCHORS.find(({ pattern }) => pattern.test(familyKey));
    if (entry) {
      for (const [providerKey, models] of Object.entries(pricingByProvider)) {
        const pricing = findKeyInsensitive<PricingRecord>(models, entry.anchor);
        if (pricing) {
          return {
            pricing,
            source: "family_anchor",
            matchedProvider: providerKey,
            matchedModel: entry.anchor,
          };
        }
      }
    }
  }

  return MISSING;
}

const reportedPricingGaps = new Set<string>();

/**
 * Log a (provider, model) pair that resolved to no pricing row, once per pair
 * per process. A gap here means every request for that model is being costed
 * at $0 — which silently deflates cost dashboards, `domain_cost_history`, and
 * any USD quota computed from them.
 *
 * Also fires for `family_anchor` hits so a new Claude tier still gets a real
 * catalog row eventually, even though its cost is already correct.
 */
export function reportMissingPricing(
  provider: string,
  model: string,
  source: PricingMatchSource
): void {
  if (source !== "missing" && source !== "family_anchor") return;

  const key = `${source}\0${(provider || "").toLowerCase()}\0${(model || "").toLowerCase()}`;
  if (reportedPricingGaps.has(key)) return;
  reportedPricingGaps.add(key);

  if (source === "missing") {
    console.warn(
      `[pricing] no pricing row for provider="${provider}" model="${model}" — ` +
        `its requests are being costed at $0. Add it to src/shared/constants/pricing/.`
    );
    return;
  }

  console.warn(
    `[pricing] provider="${provider}" model="${model}" has no pricing row; ` +
      `billing at its Claude tier rates. Add an explicit row to src/shared/constants/pricing/.`
  );
}

/** Testing seam: clears the once-per-pair log dedupe. */
export function resetMissingPricingReportsForTests(): void {
  reportedPricingGaps.clear();
}

export interface PricingGap {
  provider: string;
  model: string;
  totalTokens: number;
  /** `missing` = costed at $0; `family_anchor` = costed at Claude tier rates. */
  source: Extract<PricingMatchSource, "missing" | "family_anchor">;
}

/**
 * Find the (provider, model) pairs in a set of usage rows that have no pricing
 * row of their own, so the dashboard can show them instead of quietly
 * reporting their spend as $0.
 *
 * A gap is not cosmetic: an uncataloged model deflates the cost dashboard, the
 * `domain_cost_history` ledger, and every USD quota derived from it — which is
 * how a key kept serving traffic while its weekly quota read "99% left".
 *
 * Rows are expected to carry `provider`, `model`, and token columns; anything
 * else is skipped. Results are sorted by token volume, worst first.
 */
export function collectPricingGaps(
  pricingByProvider: PricingByProvider,
  rows: Array<Record<string, unknown>>
): PricingGap[] {
  const gaps = new Map<string, PricingGap>();

  for (const row of rows) {
    const provider = typeof row.provider === "string" ? row.provider : "";
    const model = typeof row.model === "string" ? row.model : "";
    if (!provider || !model) continue;

    const { source } = resolveModelPricing(pricingByProvider, provider, model);
    if (source !== "missing" && source !== "family_anchor") continue;

    const totalTokens =
      toFiniteNumber(row.promptTokens) +
      toFiniteNumber(row.completionTokens) +
      toFiniteNumber(row.cacheReadTokens) +
      toFiniteNumber(row.cacheCreationTokens);

    const key = `${provider.toLowerCase()}\0${model.toLowerCase()}`;
    const existing = gaps.get(key);
    if (existing) {
      existing.totalTokens += totalTokens;
      continue;
    }
    gaps.set(key, { provider, model, totalTokens, source });
  }

  return Array.from(gaps.values()).sort((left, right) => right.totalTokens - left.totalTokens);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
