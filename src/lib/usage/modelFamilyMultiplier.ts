/**
 * Shared model-family multiplier resolution — the ONE place that decides "by
 * how much should this API key's normalized cost for (provider, model) be
 * scaled?".
 *
 * Three independent surfaces need this same answer for the same request and
 * must never disagree:
 *
 *   1. `getApiKeyUsdSpendSince(..., { basis: "normalized" })`
 *      (`src/lib/usage/apiKeyUsageLimits.ts`) — feeds the key's USD quota and
 *      `@@om-usage` (read-time: recomputed from `usage_history` on every call).
 *   2. `computeUsageRowNormalizedCost`
 *      (`src/app/api/usage/analytics/route.ts`) — feeds the cost dashboard
 *      (read-time, same recompute-on-read shape).
 *   3. `billedCost` passed to `recordCost()` (`src/domain/costRules.ts`),
 *      resolved in `open-sse/handlers/chatCore.ts` /
 *      `open-sse/handlers/chatCore/streamingCost.ts` and persisted into
 *      `domain_cost_history.billed_cost` (write-time: baked in once, at the
 *      moment the request completes).
 *
 * Paths 1–2 are read-time: every call re-resolves the multiplier that is in
 * force RIGHT NOW against historical token/cost rows, so an operator edit
 * takes effect retroactively over the whole lookback window the next time
 * either is queried. Path 3 is write-time: the multiplier in force at
 * request-completion is baked into `domain_cost_history.billed_cost` once and
 * never recomputed — a later multiplier edit does not rewrite rows already on
 * disk (this mirrors billed_provider/billed_model on `usage_history`, which
 * has the exact same "no backfill, no retroactive rewrite" contract — see
 * migration 126/127). The two read-time paths (1–2) and the one write-time
 * cache (3) can disagree only for spend that happened *before* the multiplier
 * was last changed; the shared resolver below is what keeps them from
 * disagreeing for any other reason.
 *
 * Multiplier resolution always keys off the BILLED family — what the client
 * was actually charged for — never the family that SERVED the request. A
 * request redirected by a model-budget rule (opus asked, sonnet served,
 * billed at opus rates) takes the OPUS family's multiplier, if one exists,
 * even though sonnet ran. There is exactly one rule, no per-caller exception:
 * every call site below passes the effective billed (provider, model) pair —
 * `COALESCE(billed_provider, provider)` / `COALESCE(billed_model, model)` —
 * not the served one.
 *
 * @module lib/usage/modelFamilyMultiplier
 */

import {
  listFamilyMultipliers,
  MAX_FAMILY_MULTIPLIER,
  type FamilyMultiplierRule,
} from "@/lib/db/apiKeyModelFamilyMultipliers";

export type { FamilyMultiplierRule } from "@/lib/db/apiKeyModelFamilyMultipliers";

const NEUTRAL_MULTIPLIER = 1.0;

/**
 * Neutral-fallback normalization — the single place that decides what a
 * *stored* multiplier value means when applied to a cost.
 *
 * Absent (`undefined`/`null`), disabled, zero, negative, `NaN`, or an
 * empty/unparseable string all resolve to `1.0` (neutral) — NEVER `0`. A `0`
 * multiplier would make every request on the matching family read as $0 of
 * normalized spend, which silently unblocks every USD quota AND the
 * min-spend guarantee on that key at once — the single most dangerous
 * failure mode this feature can have. This is why it gets its own dedicated
 * test table (see `tests/unit/model-family-multiplier.test.ts`).
 *
 * Also clamps at `MAX_FAMILY_MULTIPLIER` as a read-time safety net. Write-time
 * validation (`requireValidMultiplier` in `apiKeyModelFamilyMultipliers.ts`)
 * already rejects out-of-range values before they can be saved through the
 * normal API — this second clamp only matters for a row that reached the
 * table some other way (a direct DB edit, a future migration, restored
 * backup from before the cap existed) and guarantees a single malformed row
 * can never multiply spend past a bounded ceiling.
 */
const clampWarnedOnce = new Set<string>();

/** Testing seam: clears the once-per-value clamp-warning dedupe. */
export function resetFamilyMultiplierClampWarningsForTests(): void {
  clampWarnedOnce.clear();
}

export function normalizeFamilyMultiplier(raw: unknown): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw.trim().replace(",", "."))
        : Number.NaN;

  if (!Number.isFinite(value) || value <= 0) return NEUTRAL_MULTIPLIER;

  if (value > MAX_FAMILY_MULTIPLIER) {
    // A row above the cap should be impossible through the normal save path
    // (`requireValidMultiplier` in apiKeyModelFamilyMultipliers.ts rejects it
    // outright) — reaching this branch means a row bypassed that write-time
    // validation (direct DB edit, restored backup, a future migration). Silently
    // clamping it forever with no signal is exactly the kind of "explicit flag,
    // not silent mixing" gap final-review Finding 2 called out elsewhere — warn
    // once per distinct value so an operator can find and fix the offending row,
    // the same pattern `pricingResolution.ts`'s `reportMissingPricing` and
    // `modelBudgetRouting.ts`'s `structuralSpendMismatchWarned` already use.
    const dedupeKey = String(value);
    if (!clampWarnedOnce.has(dedupeKey)) {
      clampWarnedOnce.add(dedupeKey);
      console.warn(
        `[modelFamilyMultiplier] a stored multiplier of ${value} exceeds ` +
          `MAX_FAMILY_MULTIPLIER (${MAX_FAMILY_MULTIPLIER}) and is being clamped to ` +
          `${MAX_FAMILY_MULTIPLIER}x on every read. This should be unreachable through ` +
          `the normal save path (src/lib/db/apiKeyModelFamilyMultipliers.ts rejects it) ` +
          `— find and fix the row that bypassed it.`
      );
    }
    return MAX_FAMILY_MULTIPLIER;
  }

  return value;
}

/**
 * Minimal GLOB-compatible matcher (`*` = any run of characters, `?` = exactly
 * one), mirroring the same convention `api_key_model_budget_rules.source_family`
 * uses via SQLite's `GLOB` operator (see `getApiKeyFamilyRealSpendSince`).
 * Reimplemented in JS (rather than round-tripping through SQL) because every
 * read-time caller already has its rows grouped/priced in memory and matches
 * per-row against a small, already-loaded rule set.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (const ch of glob) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * THE shared resolver. Every read-time and write-time cost path must call
 * this — never re-derive glob matching or the neutral-fallback rule locally —
 * so a client-visible header, a quota gate, and a dashboard total can never
 * disagree about which rule fired or what an absent/broken rule means.
 *
 * `provider`/`model` must already be the EFFECTIVE BILLED pair (see the
 * module doc comment). Returns `1.0` (neutral) whenever nothing matches,
 * including when `rules` is empty, disabled, or the pair itself is blank.
 */
export function resolveFamilyMultiplier(
  rules: readonly FamilyMultiplierRule[],
  provider: string | null | undefined,
  model: string | null | undefined
): number {
  if (!provider || !model || rules.length === 0) return NEUTRAL_MULTIPLIER;
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedProvider || !normalizedModel) return NEUTRAL_MULTIPLIER;

  const match = rules
    .filter((rule) => rule.enabled && rule.provider.trim().toLowerCase() === normalizedProvider)
    .filter((rule) => globToRegExp(rule.familyGlob.trim().toLowerCase()).test(normalizedModel))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];

  if (!match) return NEUTRAL_MULTIPLIER;
  return normalizeFamilyMultiplier(match.multiplier);
}

/**
 * Apply a resolved multiplier to a normalized cost figure. Never call this on
 * a REAL (served-model) cost — the multiplier exists to scale only what the
 * client is billed against its quota, never what OmniRoute actually pays the
 * upstream provider.
 */
export function applyFamilyMultiplier(normalizedCost: number, multiplier: number): number {
  if (!Number.isFinite(normalizedCost) || normalizedCost === 0) return normalizedCost;
  return normalizedCost * normalizeFamilyMultiplier(multiplier);
}

export interface FamilyMultiplierRuleLoader {
  (apiKeyId: string): FamilyMultiplierRule[];
}

/**
 * Load the enabled multiplier rules for one API key. Fails open to an empty
 * list (⇒ every resolution is neutral) rather than throwing — a DB hiccup
 * here must never block or corrupt a live request; see the neutral-fallback
 * contract above for why an empty rule set is always the safe default.
 */
export async function loadFamilyMultiplierRules(
  apiKeyId: string | null | undefined,
  deps: { listFamilyMultipliers?: FamilyMultiplierRuleLoader } = {}
): Promise<FamilyMultiplierRule[]> {
  if (!apiKeyId) return [];
  const loader = deps.listFamilyMultipliers ?? listFamilyMultipliers;
  try {
    return loader(apiKeyId);
  } catch {
    return [];
  }
}

/**
 * One-shot convenience for write-time callers that only need a single
 * (provider, model) resolution and don't already have a pre-fetched rule
 * list (unlike the read-time analytics/quota paths, which batch-load rules
 * once and resolve many rows against them).
 */
export async function getApiKeyFamilyMultiplier(
  apiKeyId: string | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
  deps: { listFamilyMultipliers?: FamilyMultiplierRuleLoader } = {}
): Promise<number> {
  if (!apiKeyId || !provider || !model) return NEUTRAL_MULTIPLIER;
  const rules = await loadFamilyMultiplierRules(apiKeyId, deps);
  return resolveFamilyMultiplier(rules, provider, model);
}
