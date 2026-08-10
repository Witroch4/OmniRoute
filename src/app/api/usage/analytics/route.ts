import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById, getApiKeys } from "@/lib/db/apiKeys";
import { getUserDatabaseSettings } from "@/lib/db/databaseSettings";
import {
  resolveApiKeyWeeklyWindow,
  type ApiKeyUsageLimitMetadata,
} from "@/lib/usage/apiKeyUsageLimits";
import {
  buildUnifiedSource,
  buildPresetUnifiedSource,
  getUsageSummary,
  getDailyUsage,
  getDailyCostRows,
  getHeatmapRows,
  getModelUsageRows,
  getProviderCostRows,
  getProviderUsageRows,
  getAccountCostRows,
  getAccountUsageRows,
  getApiKeyUsageRows,
  getServiceTierUsageRows,
  getApiKeyMetadataRows,
  getWeeklyPatternRows,
  getPresetCostModelRows,
} from "@/lib/db/usageAnalytics";
import { getFallbackStats } from "@/lib/db/callLogStats";
import {
  collectPricingGaps,
  reportMissingPricing,
  resolveModelPricing,
} from "@/lib/usage/pricingResolution";
import {
  applyFamilyMultiplier,
  loadFamilyMultiplierRules,
  resolveFamilyMultiplier,
  type FamilyMultiplierRule,
} from "@/lib/usage/modelFamilyMultiplier";

function getRangeStartIso(range: string): string | null {
  const end = new Date();
  const start = new Date(end);

  switch (range) {
    case "1d":
      start.setDate(start.getDate() - 1);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    case "90d":
      start.setDate(start.getDate() - 90);
      break;
    case "ytd":
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      break;
    case "all":
    default:
      return null;
  }

  return start.toISOString();
}

/**
 * Window resolution for `range=sinceReset` — deliberately NOT a case inside
 * `getRangeStartIso` above. That function is pure day arithmetic and is on
 * the hot path for every other range (including the `presets` recompute
 * loop), so it must stay synchronous and DB-free. "Since reset" instead
 * resolves through `resolveApiKeyWeeklyWindow` (the same helper the API key
 * USD quota is measured against), which is async and hits `provider_limits_cache`
 * / `quota_snapshots` — only this one range pays for that lookup.
 *
 * Scope follows the `apiKeyIds` filter already on the request:
 *   - exactly one key -> that key's own window (its `allowedConnections`,
 *     mirroring `keys/[id]/usage-limits/route.ts`);
 *   - zero or several keys -> the window over all active connections
 *     (`resolveApiKeyWeeklyWindow` already falls back to that when
 *     `allowedConnections` is empty). The provider reset is a property of the
 *     connection/account, not of any one key, so this is the same instant in
 *     practice for a single-connection deployment.
 */
async function resolveSinceResetRangeWindow(apiKeyIds: string[]): Promise<{
  windowStartIso: string;
  resetAtIso: string | null;
  isObserved: boolean;
  /**
   * False when the caller asked for a single-key-scoped window
   * (`apiKeyIds.length === 1`) but that id didn't resolve to a real key —
   * e.g. `apiKeyIds` held a legacy display name instead of an id
   * (`apiKeyWhere` accepts both: `api_key_name IN (...) OR api_key_id IN
   * (...)`). Previously this silently fell through to the same
   * all-active-connections window a genuinely unscoped request gets, with no
   * signal that the requested scope was never actually honored (final-review
   * Minor 5 — same "explicit flag over silent fallback" class as Finding 2).
   * True whenever the filter is scoped-and-resolved OR genuinely unscoped
   * (0 or 2+ keys, where "all connections" is the correct, intended answer).
   */
  scopeResolved: boolean;
}> {
  let metadata: ApiKeyUsageLimitMetadata = { id: "", allowedConnections: [] };
  let scopeResolved = true;

  if (apiKeyIds.length === 1) {
    const key = await getApiKeyById(apiKeyIds[0]);
    if (key && typeof key.id === "string") {
      metadata = {
        id: key.id,
        allowedConnections: Array.isArray(key.allowedConnections) ? key.allowedConnections : [],
      };
    } else {
      scopeResolved = false;
    }
  }

  const resolved = await resolveApiKeyWeeklyWindow(metadata);
  return { ...resolved, scopeResolved };
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type PricingByProvider = Record<string, Record<string, Record<string, unknown>>>;
type ComputeCostFromPricing = (
  pricing: Record<string, unknown> | null | undefined,
  tokens: Record<string, number | undefined> | null | undefined,
  options?: Record<string, unknown>
) => number;
type GetCodexFastCostMultiplier = (
  provider: string | null | undefined,
  model: string | null | undefined,
  serviceTier: string | null | undefined
) => number;

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeServiceTier(value: unknown): "standard" | "priority" | "flex" {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tier === "priority" || tier === "fast") return "priority";
  if (tier === "flex") return "flex";
  return "standard";
}

function getServiceTierLabelId(serviceTier: string): string {
  return normalizeServiceTier(serviceTier);
}

function appendWhereCondition(whereClause: string, condition: string): string {
  return whereClause ? `${whereClause} AND (${condition})` : `WHERE (${condition})`;
}

function makeApiKeyUsageGroup(apiKeyId: string, fallbackName: string): string {
  return apiKeyId ? `id:${apiKeyId}` : `name:${fallbackName}`;
}

function addApiKeyAlias(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) target.add(trimmed);
}

/**
 * Resolve pricing for a usage row via the shared resolver, so this dashboard
 * and `getPricingForModel` (cost modal, USD quota) can never disagree.
 *
 * This replaces a local chain that ended in two guesses: a substring match
 * between the model id and a catalog key, and — failing that — the provider's
 * FIRST catalog entry. For `cc` that first entry is `claude-fable-5`, so an
 * uncataloged `claude-opus-5` was billed at Fable rates, exactly 2x Opus,
 * reporting $1.1k for a day that actually cost $576. A wrong number that looks
 * plausible is worse than a visible gap: the shared resolver only ever returns
 * the same model's rates, plus a Claude tier anchor, and reports the rest.
 */
function resolveModelPricingForRow(
  pricingByProvider: PricingByProvider,
  providerRaw: string,
  model: string
): Record<string, unknown> | null {
  const resolution = resolveModelPricing(pricingByProvider, providerRaw, model);
  reportMissingPricing(providerRaw, model, resolution.source);
  return resolution.pricing;
}

/**
 * Resolve the (provider, model) pair a row should be priced at.
 *
 * `normalized: false` (default) uses the REAL pair — the model that actually
 * served the request. `normalized: true` uses `billed_provider`/`billed_model`
 * — the model the client asked for — falling back to the real pair when a row
 * was never redirected (NULL billed columns). Same COALESCE semantics as
 * `getApiKeyUsdSpendSince`'s `basis` option, so the dashboard and the USD
 * quota can never disagree about what "normalized" means.
 */
function resolveRowPricingPair(
  row: Record<string, unknown>,
  normalized: boolean
): { provider: string; model: string } {
  if (!normalized) {
    return { provider: toStringValue(row.provider), model: toStringValue(row.model) };
  }
  return {
    provider: toStringValue(row.billedProvider) || toStringValue(row.provider),
    model: toStringValue(row.billedModel) || toStringValue(row.model),
  };
}

/**
 * `costBasis` query param — grouping mode for the Cost Explorer table
 * (`/dashboard/costs`), not a pricing change. `real` (default, unchanged
 * behavior) groups byModel/byProvider by the model that actually SERVED the
 * request. `billed` groups them by what the client ASKED for — the pair a
 * model-budget rule redirected FROM — via `COALESCE(billed*, *)`, same basis
 * `computeUsageRowNormalizedCost`/`getApiKeyUsdSpendSince` already use.
 *
 * Only byModel and byProvider bucket identity is actually provider/model —
 * byAccount (bucketed by connection_id) and byServiceTier (bucketed by
 * service_tier) are basis-invariant: which physical account/tier served a
 * request never depends on what the client asked for, so those two already
 * expose both `cost` and `normalizedCost` per bucket with no regrouping
 * needed (Task 11). byApiKey is bucketed by API key identity, also
 * basis-invariant, for the same reason.
 */
function parseCostBasis(value: string | null): "real" | "billed" {
  return value === "billed" ? "billed" : "real";
}

function computeUsageRowCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  computeCostFromPricing: ComputeCostFromPricing,
  options: { normalized?: boolean; multiplierRules?: FamilyMultiplierRule[] } = {}
): number {
  const { provider, model } = resolveRowPricingPair(row, options.normalized ?? false);
  if (!provider || !model) return 0;
  const serviceTier = normalizeServiceTier(row.serviceTier ?? row.service_tier);

  const pricing = resolveModelPricingForRow(pricingByProvider, provider, model);
  if (!pricing) return 0;

  const cost = computeCostFromPricing(
    pricing,
    {
      input: toNumber(row.promptTokens),
      output: toNumber(row.completionTokens),
      cacheRead: toNumber(row.cacheReadTokens),
      cacheCreation: toNumber(row.cacheCreationTokens),
      reasoning: toNumber(row.reasoningTokens),
    },
    {
      provider,
      model,
      serviceTier,
      flatRateAsZero: true,
    }
  );

  // The multiplier only ever scales the NORMALIZED figure, and only when the
  // caller actually resolved a rule set for this row's owning key — never the
  // real (served-model) cost. See computeUsageRowNormalizedCost's doc comment
  // for how `multiplierRules` is selected per bucket.
  if (!options.normalized || !options.multiplierRules || options.multiplierRules.length === 0) {
    return cost;
  }
  const multiplier = resolveFamilyMultiplier(options.multiplierRules, provider, model);
  return applyFamilyMultiplier(cost, multiplier);
}

/**
 * Normalized-basis twin of `computeUsageRowCost` — same pricing path, priced
 * at the requested (billed) model instead of the real one, then scaled by
 * that billed family's multiplier (migration 128) when `multiplierRules` has
 * one. This is the figure every client-facing surface (API key USD quota,
 * `@@om-usage`) reports; see `getApiKeyUsdSpendSince`'s doc comment for the
 * full basis contract, and `resolveFamilyMultiplier`'s doc comment for why
 * the multiplier is per-key.
 *
 * `multiplierRules` (final-review Finding 2 fix): every caller passes
 * `multiplierRulesForRow(row)` — the SAME shared, per-row resolver, built
 * once in `GET` from every row set's OWN `api_key_id` column. Every bucket in
 * this route (byModel/byProvider/byAccount/byServiceTier/byApiKey) now
 * resolves the multiplier per SQL row, before re-merging into the coarser
 * output bucket — never a single request-wide scope. This is what closes the
 * original bug: `byApiKey` used to resolve a real per-row multiplier while
 * every other bucket only did so when the request happened to be filtered to
 * one key, so the exact same underlying traffic could show
 * `byApiKey.normalizedCost` disagreeing with `byModel.normalizedCost` inside
 * one response. The one gap that remains, and is impossible to close without
 * fabricating an attribution: a row whose `api_key_id` is NULL (rolled up
 * into `daily_usage_summary`, which drops per-key attribution by design, or a
 * request that genuinely had no api key) resolves to an empty rule set
 * (neutral, 1.0x) for THAT row only — surfaced honestly via the response's
 * `normalizedCostCoverage` flags rather than silently mixed into a
 * precise-looking total.
 */
function computeUsageRowNormalizedCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  computeCostFromPricing: ComputeCostFromPricing,
  multiplierRules: FamilyMultiplierRule[] = []
): number {
  return computeUsageRowCost(row, pricingByProvider, computeCostFromPricing, {
    normalized: true,
    multiplierRules,
  });
}

function computeUsageRowStandardCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  computeCostFromPricing: ComputeCostFromPricing
): number {
  return computeUsageRowCost(
    { ...row, serviceTier: "standard", service_tier: "standard" },
    pricingByProvider,
    computeCostFromPricing
  );
}

interface BilledProviderRow {
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successRatePct: number;
  cost: number;
  normalizedCost: number;
}

/**
 * `byProvider` for `costBasis=billed` — buckets by `COALESCE(billed_provider,
 * provider)` instead of the real (served) provider, derived from `modelRows`
 * (`getModelUsageRows`) since that query already carries billed_provider per
 * row while `getProviderUsageRows` does not. See the comment at its call site
 * in `GET` for why re-deriving from the finer-grained model rows is exact.
 */
function buildBilledProviderRows(
  modelRows: Array<Record<string, unknown>>,
  pricingByProvider: PricingByProvider,
  computeCostFromPricing: ComputeCostFromPricing,
  multiplierRulesForRow: (row: Record<string, unknown>) => FamilyMultiplierRule[]
): BilledProviderRow[] {
  const providerMap = new Map<
    string,
    {
      provider: string;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      latencyWeightedTotal: number;
      successfulRequests: number;
      cost: number;
      normalizedCost: number;
    }
  >();

  for (const row of modelRows) {
    const realProvider = toStringValue(row.provider);
    if (!realProvider) continue;
    const billedProvider = toStringValue(row.billedProvider) || realProvider;
    const requests = toNumber(row.requests);

    const existing = providerMap.get(billedProvider) || {
      provider: billedProvider,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyWeightedTotal: 0,
      successfulRequests: 0,
      cost: 0,
      normalizedCost: 0,
    };

    existing.requests += requests;
    existing.promptTokens += toNumber(row.promptTokens);
    existing.completionTokens += toNumber(row.completionTokens);
    existing.totalTokens += toNumber(row.totalTokens);
    existing.latencyWeightedTotal += toNumber(row.avgLatencyMs) * requests;
    existing.successfulRequests += toNumber(row.successfulRequests);
    // Real cost is always priced at the model that actually ran, regardless
    // of which bucket the row lands in — same contract as `computeUsageRowCost`
    // everywhere else in this route.
    existing.cost += computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
    existing.normalizedCost += computeUsageRowNormalizedCost(
      row,
      pricingByProvider,
      computeCostFromPricing,
      multiplierRulesForRow(row)
    );
    providerMap.set(billedProvider, existing);
  }

  return Array.from(providerMap.values())
    .map((row) => ({
      provider: row.provider,
      requests: row.requests,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      avgLatencyMs: row.requests > 0 ? Math.round(row.latencyWeightedTotal / row.requests) : 0,
      successRatePct:
        row.requests > 0 ? Number(((row.successfulRequests / row.requests) * 100).toFixed(2)) : 0,
      cost: roundCost(row.cost),
      normalizedCost: roundCost(row.normalizedCost),
    }))
    .sort((left, right) => right.requests - left.requests);
}

function computeUsageSavingsTokens(
  row: Record<string, unknown>,
  serviceTier: string,
  getCodexFastCostMultiplier: GetCodexFastCostMultiplier
): number {
  const provider = toStringValue(row.provider);
  const model = toStringValue(row.model);
  const totalTokens = toNumber(row.totalTokens);
  if (!provider || !model || totalTokens <= 0) return 0;

  const standardMultiplier = getCodexFastCostMultiplier(provider, model, "standard");
  if (standardMultiplier <= 0) return 0;

  const actualMultiplier = getCodexFastCostMultiplier(provider, model, serviceTier);
  const savingsRatio = Math.max(0, (standardMultiplier - actualMultiplier) / standardMultiplier);
  return totalTokens * savingsRatio;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function computeActivityStreak(activityMap: Record<string, number>): number {
  const cursor = new Date();
  let streak = 0;

  while ((activityMap[formatUtcDate(cursor)] || 0) > 0) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return streak;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const apiKeyIdsParam = searchParams.get("apiKeyIds") || "";
    const apiKeyIds = apiKeyIdsParam ? apiKeyIdsParam.split(",").filter(Boolean) : [];
    const costBasis = parseCostBasis(searchParams.get("costBasis"));

    // Explicit startDate (custom date-range picker) always wins, same as before.
    // Otherwise "sinceReset" resolves asynchronously through the provider's
    // observed weekly window; every other range keeps the pure/sync arithmetic
    // path unchanged (see resolveSinceResetRangeWindow's doc comment).
    let sinceIso: string | null;
    let resetWindow: {
      resetAtIso: string | null;
      isObserved: boolean;
      windowStartIso: string;
      scopeResolved: boolean;
    } | null = null;
    if (startDate) {
      sinceIso = startDate;
    } else if (range === "sinceReset") {
      const resolved = await resolveSinceResetRangeWindow(apiKeyIds);
      sinceIso = resolved.windowStartIso;
      resetWindow = {
        resetAtIso: resolved.resetAtIso,
        isObserved: resolved.isObserved,
        windowStartIso: resolved.windowStartIso,
        // False = the apiKeyIds filter named exactly one id but it wasn't a real key
        // (e.g. a legacy display name) — the window below silently widened to "all
        // active connections" instead of the single-key scope that was asked for.
        scopeResolved: resolved.scopeResolved,
      };
    } else {
      sinceIso = getRangeStartIso(range);
    }
    const untilIso = endDate || null;
    const presetsParam = searchParams.get("presets");

    const apiKeys = await getApiKeys();
    const currentApiKeyNames = new Map<string, string>();
    for (const apiKey of apiKeys) {
      if (typeof apiKey.id === "string" && typeof apiKey.name === "string") {
        currentApiKeyNames.set(apiKey.id, apiKey.name);
      }
    }

    // Compute the raw-data cutoff: rows older than this may have been rolled up to
    // daily_usage_summary and deleted from usage_history.
    const dbSettings = getUserDatabaseSettings();
    const rawRetentionDays = dbSettings.aggregation?.rawDataRetentionDays ?? 30;
    const rawCutoff = new Date();
    rawCutoff.setDate(rawCutoff.getDate() - rawRetentionDays);
    const rawCutoffIso = rawCutoff.toISOString();

    const conditions = [];
    const params: Record<string, string> = {};

    if (sinceIso) {
      conditions.push("timestamp >= @since");
      params.since = sinceIso;
    }
    if (untilIso) {
      conditions.push("timestamp <= @until");
      params.until = untilIso;
    }

    let apiKeyWhere = "";
    if (apiKeyIds.length > 0) {
      const placeholders = apiKeyIds.map((_, i) => `@apiKey${i}`);
      apiKeyIds.forEach((key, i) => {
        params[`apiKey${i}`] = key;
      });
      apiKeyWhere = `(api_key_name IN (${placeholders.join(",")}) OR api_key_id IN (${placeholders.join(",")}))`;
      conditions.push(apiKeyWhere);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Build the UNION data source that merges recent raw rows with older aggregated history.
    // SQL is encapsulated in usageAnalytics.ts — the route only supplies filter parameters.
    const rawCutoffDate = rawCutoffIso.split("T")[0];
    const apiKeyParamEntries: Record<string, string> = {};
    apiKeyIds.forEach((key, i) => {
      apiKeyParamEntries[`apiKey${i}`] = key;
    });

    const { unifiedSource, unifiedParams } = buildUnifiedSource({
      sinceIso: sinceIso ?? null,
      untilIso: untilIso ?? null,
      rawCutoffDate,
      apiKeyWhere,
      apiKeyParams: apiKeyParamEntries,
    });

    // Fetch pricing data for cost calculation (no rows loaded)
    const { getPricing } = await import("@/lib/db/settings");
    const rawPricingByProvider = (await getPricing()) as PricingByProvider;

    // Pre-process pricing data to lowercase keys for O(1) lookups
    const pricingByProvider: PricingByProvider = {};
    for (const [providerKey, providerVal] of Object.entries(rawPricingByProvider || {})) {
      const lowerProvider = {};
      for (const [modelKey, modelVal] of Object.entries(providerVal || {})) {
        (lowerProvider as any)[modelKey.toLowerCase()] = modelVal;
      }
      pricingByProvider[providerKey.toLowerCase()] = lowerProvider;
    }
    const { computeCostFromPricing, getCodexFastCostMultiplier, normalizeModelName } =
      await import("@/lib/usage/costCalculator");

    const summaryRow = getUsageSummary(unifiedSource, unifiedParams) as Record<string, unknown>;

    const dailyRows = getDailyUsage(unifiedSource, unifiedParams) as Array<Record<string, unknown>>;

    const dailyCostRows = getDailyCostRows(unifiedSource, unifiedParams) as Array<
      Record<string, unknown>
    >;

    const heatmapStart = new Date();
    heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
    // Custom date range might need a wider heatmap window
    if (startDate) {
      const customStart = new Date(startDate);
      if (customStart.getTime() < heatmapStart.getTime()) {
        heatmapStart.setTime(customStart.getTime());
      }
    }

    // Heatmap needs its own whereClause if api keys are filtered
    const heatmapConditions = ["timestamp >= @heatmapStart"];
    if (apiKeyWhere) heatmapConditions.push(apiKeyWhere);
    const heatmapParams: Record<string, string> = { heatmapStart: heatmapStart.toISOString() };
    if (apiKeyIds.length > 0) {
      apiKeyIds.forEach((key, i) => {
        heatmapParams[`apiKey${i}`] = key;
      });
    }

    const heatmapRows = getHeatmapRows(heatmapConditions, heatmapParams) as Array<
      Record<string, unknown>
    >;

    const modelRows = getModelUsageRows(unifiedSource, unifiedParams) as Array<
      Record<string, unknown>
    >;

    const providerCostRows = getProviderCostRows(unifiedSource, unifiedParams) as Array<
      Record<string, unknown>
    >;

    const providerRows = getProviderUsageRows(unifiedSource, unifiedParams) as Array<
      Record<string, unknown>
    >;

    const accountCostWhereClause = whereClause
      .replace(/timestamp/g, "usage_history.timestamp")
      .replace(/api_key_/g, "usage_history.api_key_");
    const accountCostRows = getAccountCostRows(accountCostWhereClause, params) as Array<
      Record<string, unknown>
    >;

    const accountRows = getAccountUsageRows(accountCostWhereClause, params) as Array<
      Record<string, unknown>
    >;

    const apiKeyWhereClause = appendWhereCondition(
      whereClause,
      "(api_key_id IS NOT NULL AND api_key_id != '') OR (api_key_name IS NOT NULL AND api_key_name != '')"
    );
    const apiKeyRows = getApiKeyUsageRows(apiKeyWhereClause, params) as Array<
      Record<string, unknown>
    >;

    const serviceTierRows = getServiceTierUsageRows(unifiedSource, unifiedParams) as Array<
      Record<string, unknown>
    >;

    // Model-family multiplier (migration 128) is per-API-KEY-ID. Every row set fetched
    // above now carries its OWN api_key_id (final-review Finding 2 fix) — except rows
    // that came from the rolled-up `daily_usage_summary` leg (key attribution is
    // intentionally dropped on rollup, see usageAnalytics/sources.ts) or requests with
    // no api key, where `apiKeyId` is NULL and the multiplier cannot be resolved for
    // that row at all. One shared cache, loaded once per distinct key seen across every
    // row set (never re-fetched per bucket), and one resolver every bucket below uses
    // uniformly — this is what closes Finding 2: `byApiKey` used to resolve a real
    // per-row multiplier while every OTHER bucket only did so when the request
    // happened to be scoped to a single filtered key, so the same response could show
    // `byApiKey.normalizedCost` and `byModel.normalizedCost` disagreeing for the exact
    // same underlying traffic.
    const distinctApiKeyIdsInRows = Array.from(
      new Set(
        [...modelRows, ...providerCostRows, ...accountCostRows, ...serviceTierRows, ...apiKeyRows]
          .map((row) => toStringValue(row.apiKeyId))
          .filter(Boolean)
      )
    );
    const apiKeyMultiplierRulesById = new Map<string, FamilyMultiplierRule[]>(
      await Promise.all(
        distinctApiKeyIdsInRows.map(
          async (id) => [id, await loadFamilyMultiplierRules(id)] as const
        )
      )
    );
    function multiplierRulesForRow(row: Record<string, unknown>): FamilyMultiplierRule[] {
      const apiKeyId = toStringValue(row.apiKeyId);
      return apiKeyId ? (apiKeyMultiplierRulesById.get(apiKeyId) ?? []) : [];
    }
    function rowHasKeyAttribution(row: Record<string, unknown>): boolean {
      return Boolean(toStringValue(row.apiKeyId));
    }
    /**
     * True only when EVERY row behind a bucket had real key attribution, so its
     * normalizedCost is a complete, multiplier-aware figure. False means at least one
     * contributing row (almost always: old traffic rolled up into
     * `daily_usage_summary`) had no `api_key_id` and was priced at a neutral (1.0)
     * multiplier for that slice — an explicit signal instead of a silently-mixed
     * number, per final-review Finding 2 ("must carry an explicit flag rather than
     * silently mixing bases").
     */
    function computeMultiplierCoverage(rows: Array<Record<string, unknown>>): boolean {
      return rows.every(rowHasKeyAttribution);
    }

    const apiKeyMetadataRows = getApiKeyMetadataRows(apiKeyWhereClause, params) as Array<
      Record<string, unknown>
    >;

    const apiKeyMetadata = new Map<string, { latestName: string; aliases: Set<string> }>();
    for (const row of apiKeyMetadataRows) {
      const apiKeyId = toStringValue(row.apiKeyId);
      const apiKeyGroupKey = toStringValue(row.apiKeyGroupKey, "unknown");
      const groupKey = makeApiKeyUsageGroup(apiKeyId, apiKeyGroupKey);
      const existing = apiKeyMetadata.get(groupKey) || {
        latestName: "",
        aliases: new Set<string>(),
      };
      const apiKeyName = toStringValue(row.apiKeyName);
      if (!existing.latestName && apiKeyName) existing.latestName = apiKeyName;
      addApiKeyAlias(existing.aliases, apiKeyName);
      apiKeyMetadata.set(groupKey, existing);
    }

    const weeklyRows = getWeeklyPatternRows(unifiedSource, unifiedParams) as Array<
      Record<string, unknown>
    >;

    const fallbackRow = getFallbackStats(whereClause, params) as Record<string, unknown>;

    const summary = {
      totalRequests: Number(summaryRow?.totalRequests || 0),
      promptTokens: Number(summaryRow?.promptTokens || 0),
      completionTokens: Number(summaryRow?.completionTokens || 0),
      totalTokens: Number(summaryRow?.totalTokens || 0),
      uniqueModels: Number(summaryRow?.uniqueModels || 0),
      uniqueAccounts: Number(summaryRow?.uniqueAccounts || 0),
      uniqueApiKeys: Number(summaryRow?.uniqueApiKeys || 0),
      successfulRequests: Number(summaryRow?.successfulRequests || 0),
      successRatePct:
        Number(summaryRow?.totalRequests || 0) > 0
          ? Number(
              (
                (Number(summaryRow?.successfulRequests || 0) /
                  Number(summaryRow?.totalRequests || 1)) *
                100
              ).toFixed(2)
            )
          : 0,
      avgLatencyMs: Math.round(Number(summaryRow?.avgLatencyMs || 0)),
      totalCost: 0,
      firstRequest: summaryRow?.firstRequest || "",
      lastRequest: summaryRow?.lastRequest || "",
      fallbackCount: Number(fallbackRow?.fallbacks || 0),
      fastRequests: 0,
      standardRequests: 0,
      flexRequests: 0,
      fastCost: 0,
      standardCost: 0,
      flexCost: 0,
      flexSavings: 0,
      flexUsageSavingsTokens: 0,
      fastRequestSharePct: 0,
      fallbackRatePct:
        Number(fallbackRow?.fallback_eligible || 0) > 0
          ? Number(
              (
                (Number(fallbackRow?.fallbacks || 0) /
                  Number(fallbackRow?.fallback_eligible || 1)) *
                100
              ).toFixed(2)
            )
          : 0,
      requestedModelCoveragePct:
        Number(fallbackRow?.total || 0) > 0
          ? Number(
              (
                (Number(fallbackRow?.with_requested || 0) / Number(fallbackRow?.total || 1)) *
                100
              ).toFixed(2)
            )
          : 0,
      streak: 0,
    };

    const dailyByModelMap: Record<string, Record<string, number>> = {};
    const allModels = new Set<string>();

    const dailyCostByDate = new Map<string, number>();
    for (const row of dailyCostRows) {
      const date = toStringValue(row.date);
      if (!date) continue;

      // Calculate costs
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
      dailyCostByDate.set(date, (dailyCostByDate.get(date) || 0) + cost);

      // Group tokens by model for the day
      const model = normalizeModelName(row.model as string);
      const tokens = Number(row.promptTokens) + Number(row.completionTokens);

      if (!dailyByModelMap[date]) dailyByModelMap[date] = {};
      dailyByModelMap[date][model] = (dailyByModelMap[date][model] || 0) + tokens;
      allModels.add(model);
    }

    const dailyTrend = dailyRows.map((row) => ({
      date: row.date,
      requests: Number(row.requests),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      totalTokens: Number(row.totalTokens),
      cost: roundCost(dailyCostByDate.get(toStringValue(row.date)) || 0),
    }));

    const activityMap: Record<string, number> = {};
    for (const row of heatmapRows) {
      activityMap[row.date as string] = Number(row.totalTokens);
    }
    summary.streak = computeActivityStreak(activityMap);

    const modelMap = new Map<string, Record<string, unknown>>();
    for (const row of modelRows) {
      const realModel = row.model as string;
      const realProvider = row.provider as string;
      // `costBasis=real` (default) groups by the served pair — byte-identical
      // to pre-costBasis behavior. `costBasis=billed` groups by what the
      // client asked for, so a redirected row's requests/tokens/cost land in
      // the REQUESTED family's bucket instead of the family that actually ran.
      const groupProvider =
        costBasis === "billed" ? toStringValue(row.billedProvider) || realProvider : realProvider;
      const groupModel =
        costBasis === "billed" ? toStringValue(row.billedModel) || realModel : realModel;
      const short = normalizeModelName(groupModel);
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
      const normalizedCost = computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row)
      );
      const key = `${groupProvider}::${groupModel}`;
      const existing = modelMap.get(key) || {
        model: short,
        provider: groupProvider,
        rawModel: groupModel,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyWeightedTotal: 0,
        successfulRequests: 0,
        lastUsed: "",
        cost: 0,
        normalizedCost: 0,
      };
      const requests = Number(row.requests) || 0;
      existing.requests = Number(existing.requests || 0) + requests;
      existing.promptTokens = Number(existing.promptTokens || 0) + Number(row.promptTokens || 0);
      existing.completionTokens =
        Number(existing.completionTokens || 0) + Number(row.completionTokens || 0);
      existing.totalTokens = Number(existing.totalTokens || 0) + Number(row.totalTokens || 0);
      existing.latencyWeightedTotal =
        Number(existing.latencyWeightedTotal || 0) + Number(row.avgLatencyMs || 0) * requests;
      existing.successfulRequests =
        Number(existing.successfulRequests || 0) + Number(row.successfulRequests || 0);
      if (!existing.lastUsed || String(row.lastUsed || "") > String(existing.lastUsed || "")) {
        existing.lastUsed = row.lastUsed;
      }
      existing.cost = Number(existing.cost || 0) + cost;
      existing.normalizedCost = Number(existing.normalizedCost || 0) + normalizedCost;
      modelMap.set(key, existing);
    }

    const byModel = Array.from(modelMap.values())
      .map((row) => ({
        model: row.model,
        provider: row.provider,
        rawModel: row.rawModel,
        requests: Number(row.requests),
        promptTokens: Number(row.promptTokens),
        completionTokens: Number(row.completionTokens),
        totalTokens: Number(row.totalTokens),
        avgLatencyMs:
          Number(row.requests) > 0
            ? Math.round(Number(row.latencyWeightedTotal || 0) / Number(row.requests))
            : 0,
        successRatePct:
          Number(row.requests) > 0
            ? Number((Number(row.successfulRequests || 0) / Number(row.requests)) * 100).toFixed(2)
            : 0,
        lastUsed: row.lastUsed,
        cost: roundCost(Number(row.cost || 0)),
        normalizedCost: roundCost(Number(row.normalizedCost || 0)),
      }))
      .sort((left, right) => Number(right.requests) - Number(left.requests))
      .slice(0, 50);

    const totalCost = Array.from(dailyCostByDate.values()).reduce((sum, cost) => sum + cost, 0);
    summary.totalCost = roundCost(totalCost);

    const providerCostByProvider = new Map<string, number>();
    const providerNormalizedCostByProvider = new Map<string, number>();
    for (const row of providerCostRows) {
      const provider = toStringValue(row.provider);
      if (!provider) continue;
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
      const normalizedCost = computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row)
      );
      providerCostByProvider.set(provider, (providerCostByProvider.get(provider) || 0) + cost);
      providerNormalizedCostByProvider.set(
        provider,
        (providerNormalizedCostByProvider.get(provider) || 0) + normalizedCost
      );
    }

    // Models with no pricing row are costed at $0 and silently deflate every
    // number on this page (and the USD quotas derived from it). Surface them
    // so the dashboard can warn instead of under-reporting.
    const pricingGaps = collectPricingGaps(pricingByProvider, providerCostRows);

    // `providerRows` (getProviderUsageRows) only groups by the REAL provider —
    // it carries no billed_provider dimension, so it can't answer "how many
    // requests did the client BILL to provider X" (a rule can redirect across
    // providers, not just families within one). costBasis=real reuses it
    // unchanged (zero behavior change from before this param existed).
    // costBasis=billed instead re-derives provider-level requests/tokens/
    // latency/success from `modelRows`, which already carries billed_provider
    // per row (Task 11) at a finer grain than provider-only — summing it back
    // up to provider level is a strict coarsening of the same rows, so it's
    // exact, not an approximation.
    const byProvider =
      costBasis === "billed"
        ? buildBilledProviderRows(
            modelRows,
            pricingByProvider,
            computeCostFromPricing,
            multiplierRulesForRow
          )
        : providerRows.map((row) => ({
            provider: row.provider,
            requests: Number(row.requests),
            promptTokens: Number(row.promptTokens),
            completionTokens: Number(row.completionTokens),
            totalTokens: Number(row.totalTokens),
            avgLatencyMs: Math.round(Number(row.avgLatencyMs)),
            successRatePct:
              Number(row.requests) > 0
                ? Number((Number(row.successfulRequests) / Number(row.requests)) * 100).toFixed(2)
                : 0,
            cost: roundCost(providerCostByProvider.get(toStringValue(row.provider)) || 0),
            normalizedCost: roundCost(
              providerNormalizedCostByProvider.get(toStringValue(row.provider)) || 0
            ),
          }));

    const accountCostByAccount = new Map<string, number>();
    const accountNormalizedCostByAccount = new Map<string, number>();
    for (const row of accountCostRows) {
      const account = toStringValue(row.account, "unknown");
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
      const normalizedCost = computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row)
      );
      accountCostByAccount.set(account, (accountCostByAccount.get(account) || 0) + cost);
      accountNormalizedCostByAccount.set(
        account,
        (accountNormalizedCostByAccount.get(account) || 0) + normalizedCost
      );
    }

    const byAccount = accountRows.map((row) => ({
      account: toStringValue(row.account, "unknown"),
      requests: Number(row.requests),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      totalTokens: Number(row.totalTokens),
      avgLatencyMs: Math.round(Number(row.avgLatencyMs)),
      lastUsed: row.lastUsed,
      cost: roundCost(accountCostByAccount.get(toStringValue(row.account, "unknown")) || 0),
      normalizedCost: roundCost(
        accountNormalizedCostByAccount.get(toStringValue(row.account, "unknown")) || 0
      ),
    }));

    const apiKeyMap = new Map<
      string,
      {
        apiKey: string;
        apiKeyId: string | null;
        apiKeyName: string;
        historicalApiKeyNames: string[];
        requests: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
        normalizedCost: number;
      }
    >();
    for (const row of apiKeyRows) {
      const apiKeyId = toStringValue(row.apiKeyId);
      const apiKeyGroupKey = toStringValue(row.apiKeyGroupKey, "unknown");
      const key = makeApiKeyUsageGroup(apiKeyId, apiKeyGroupKey);
      const metadata = apiKeyMetadata.get(key);
      const apiKeyName =
        (apiKeyId ? currentApiKeyNames.get(apiKeyId) : undefined) ||
        metadata?.latestName ||
        apiKeyId ||
        apiKeyGroupKey ||
        "Unknown API key";
      const existing = apiKeyMap.get(key) || {
        apiKey: apiKeyId && apiKeyName !== apiKeyId ? `${apiKeyName} (${apiKeyId})` : apiKeyName,
        apiKeyId: apiKeyId || null,
        apiKeyName,
        historicalApiKeyNames: Array.from(metadata?.aliases || []),
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        normalizedCost: 0,
      };

      existing.requests += Number(row.requests);
      existing.promptTokens += Number(row.promptTokens);
      existing.completionTokens += Number(row.completionTokens);
      existing.totalTokens += Number(row.totalTokens);
      existing.cost += computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
      existing.normalizedCost += computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row)
      );
      apiKeyMap.set(key, existing);
    }
    const byApiKey = Array.from(apiKeyMap.values())
      .map((row) => ({
        ...row,
        cost: roundCost(row.cost),
        normalizedCost: roundCost(row.normalizedCost),
      }))
      .sort((left, right) => right.cost - left.cost);

    const serviceTierMap = new Map<
      string,
      {
        serviceTier: "standard" | "priority" | "flex";
        label: string;
        requests: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
        normalizedCost: number;
        savings: number;
        usageSavingsTokens: number;
      }
    >();
    for (const row of serviceTierRows) {
      const serviceTier = normalizeServiceTier(row.serviceTier);
      const existing = serviceTierMap.get(serviceTier) || {
        serviceTier,
        label: getServiceTierLabelId(serviceTier),
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        normalizedCost: 0,
        savings: 0,
        usageSavingsTokens: 0,
      };
      existing.requests += Number(row.requests || 0);
      existing.promptTokens += Number(row.promptTokens || 0);
      existing.completionTokens += Number(row.completionTokens || 0);
      existing.totalTokens += Number(row.totalTokens || 0);
      const actualCost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
      existing.cost += actualCost;
      existing.normalizedCost += computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row)
      );
      if (serviceTier === "flex") {
        const standardCost = computeUsageRowStandardCost(
          row,
          pricingByProvider,
          computeCostFromPricing
        );
        existing.savings += Math.max(0, standardCost - actualCost);
        existing.usageSavingsTokens += computeUsageSavingsTokens(
          row,
          serviceTier,
          getCodexFastCostMultiplier
        );
      }
      serviceTierMap.set(serviceTier, existing);
    }
    const byServiceTier = Array.from(serviceTierMap.values())
      .map((row) => ({
        ...row,
        cost: roundCost(row.cost),
        normalizedCost: roundCost(row.normalizedCost),
        savings: roundCost(row.savings),
        usageSavingsTokens: Math.round(row.usageSavingsTokens),
      }))
      .sort((left, right) => {
        const order = { priority: 0, flex: 1, standard: 2 } as const;
        return order[left.serviceTier] - order[right.serviceTier];
      });
    const fastTier = serviceTierMap.get("priority");
    const flexTier = serviceTierMap.get("flex");
    const standardTier = serviceTierMap.get("standard");
    summary.fastRequests = fastTier?.requests || 0;
    summary.fastCost = roundCost(fastTier?.cost || 0);
    summary.flexRequests = flexTier?.requests || 0;
    summary.flexCost = roundCost(flexTier?.cost || 0);
    summary.flexSavings = roundCost(flexTier?.savings || 0);
    summary.flexUsageSavingsTokens = Math.round(flexTier?.usageSavingsTokens || 0);
    summary.standardRequests = standardTier?.requests || 0;
    summary.standardCost = roundCost(standardTier?.cost || 0);
    summary.fastRequestSharePct =
      summary.totalRequests > 0
        ? Number(((Number(summary.fastRequests) / Number(summary.totalRequests)) * 100).toFixed(2))
        : 0;

    const weeklyTokens = [0, 0, 0, 0, 0, 0, 0];
    const weeklyCounts = [0, 0, 0, 0, 0, 0, 0];
    const weeklyPattern = WEEKDAY_LABELS.map((day) => ({
      day,
      avgTokens: 0,
      totalTokens: 0,
    }));
    for (const row of weeklyRows) {
      const dayIdx = Number(row.dayOfWeek);
      if (dayIdx >= 0 && dayIdx <= 6) {
        const totalTokens = Number(row.totalTokens);
        const days = Number(row.days);
        weeklyTokens[dayIdx] = totalTokens;
        weeklyCounts[dayIdx] = Number(row.requests);
        weeklyPattern[dayIdx] = {
          day: WEEKDAY_LABELS[dayIdx],
          avgTokens: days > 0 ? Math.round(totalTokens / days) : 0,
          totalTokens,
        };
      }
    }

    const dailyByModel = Object.keys(dailyByModelMap)
      .sort()
      .map((date) => ({ date, ...dailyByModelMap[date] }));
    const modelNames = Array.from(allModels);

    // Final-review Finding 2: explicit, per-bucket signal for whether EVERY row behind
    // that bucket's normalizedCost had real key attribution (so the multiplier could be
    // resolved for all of it) — false means some contributing traffic (almost always
    // old rows rolled up into daily_usage_summary, which drops api_key_id by design)
    // was priced at a neutral 1.0x multiplier because there was no key to look rules up
    // for. `byProvider`'s source row set depends on `costBasis` — real groups from
    // `providerCostRows`, billed groups from `modelRows` (via `buildBilledProviderRows`).
    const normalizedCostCoverage = {
      byModel: computeMultiplierCoverage(modelRows),
      byProvider: computeMultiplierCoverage(costBasis === "billed" ? modelRows : providerCostRows),
      byAccount: computeMultiplierCoverage(accountCostRows),
      byServiceTier: computeMultiplierCoverage(serviceTierRows),
      byApiKey: computeMultiplierCoverage(apiKeyRows),
    };

    const analytics = {
      summary,
      pricingGaps,
      costBasis,
      dailyTrend,
      activityMap,
      byModel,
      byProvider,
      byApiKey,
      byAccount,
      byServiceTier,
      weeklyPattern,
      weeklyTokens,
      weeklyCounts,
      dailyByModel,
      modelNames,
      range,
      // Only set for range=sinceReset — see resolveSinceResetRangeWindow. The
      // UI must not present a `!isObserved` window as "since the provider
      // reset"; it is a rolling-7d fallback wearing that range's clothes.
      resetWindow,
      normalizedCostCoverage,
    } as any;

    if (presetsParam) {
      const allowedRanges = new Set(["1d", "7d", "30d", "90d", "ytd", "all"]);
      const presetRanges = presetsParam
        .split(",")
        .map((preset) => preset.trim())
        .filter((preset) => allowedRanges.has(preset));
      const presetSummaries: Record<string, { totalCost: number }> = {};

      for (const presetRange of presetRanges) {
        if (presetRange === range) {
          presetSummaries[presetRange] = {
            totalCost: Number(analytics.summary?.totalCost || 0),
          };
          continue;
        }

        const presetSinceIso = getRangeStartIso(presetRange);
        const { unifiedSource: presetUnifiedSource, unifiedParams: presetParams } =
          buildPresetUnifiedSource({
            sinceIso: presetSinceIso ?? null,
            untilIso: null,
            rawCutoffDate,
            apiKeyWhere,
            apiKeyParams: apiKeyParamEntries,
          });

        const presetModelRows = getPresetCostModelRows(presetUnifiedSource, presetParams) as Array<
          Record<string, unknown>
        >;

        let presetTotalCost = 0;
        for (const row of presetModelRows) {
          presetTotalCost += computeUsageRowCost(row, pricingByProvider, computeCostFromPricing);
        }

        presetSummaries[presetRange] = {
          totalCost: roundCost(presetTotalCost),
        };
      }

      analytics.presetSummaries = presetSummaries;
    }

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("Error computing analytics:", error);
    // Surface the real (sanitized) reason so the dashboard can show it instead of a
    // generic placeholder (#3356). buildErrorBody strips stacks/absolute paths.
    const { buildErrorBody } = await import("@omniroute/open-sse/utils/error");
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(buildErrorBody(500, message || "Failed to compute analytics"), {
      status: 500,
    });
  }
}
