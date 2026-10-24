import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { getProviderById } from "@/shared/constants/providers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { serveAnalyticsCached } from "@/lib/usage/analyticsResponseCache";
import { readLongContextColumns } from "@/lib/usage/longContextSql";
import { getApiKeys } from "@/lib/db/apiKeys";
import { getUserDatabaseSettings } from "@/lib/db/databaseSettings";
import {
  parseCostBasis,
  resolveRowPricingPair,
  resolveSinceResetRangeWindow,
} from "@/lib/usage/analyticsCostBasis";
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
  getApiKeyTotalsRows,
  type ApiKeyTotalsRow,
  getServiceTierUsageRows,
  getApiKeyMetadataRows,
  getWeeklyPatternRows,
  getPresetCostModelRows,
} from "@/lib/db/usageAnalytics";
import { getFallbackStats, getErrorTypeBreakdown } from "@/lib/db/callLogStats";
import {
  buildByProviderRows,
  getProviderDisplayNameResolver,
} from "@/lib/usage/providerDisplayNames";
import { isFlatRateProvider } from "@/lib/usage/flatRateProviders";
import { toNumber } from "@/shared/utils/numeric";
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
    case "180d":
      start.setDate(start.getDate() - 180);
      break;
    case "365d":
      start.setDate(start.getDate() - 365);
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

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type PricingByProvider = Record<string, Record<string, Record<string, unknown>>>;
type UsageRows = Array<Record<string, unknown>>;
type ComputeCostFromPricing = typeof import("@/lib/usage/costCalculator").computeCostFromPricing;
type GetCodexFastCostMultiplier = (
  provider: string | null | undefined,
  model: string | null | undefined,
  serviceTier: string | null | undefined
) => number;

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

type ApiKeyTotals = {
  apiKeyId: string;
  apiKeyName: string;
  requests: number;
  cost: number;
  lastUsed: string | null;
};

/**
 * Lifetime totals for each current API key. Rows recorded before per-key ids
 * existed carry only a key name: they count toward last use, matched by name,
 * but not toward requests or cost.
 */
function buildApiKeyTotals(
  rows: ApiKeyTotalsRow[],
  apiKeys: Array<{ id?: unknown; name?: unknown }>,
  rowCost: (row: ApiKeyTotalsRow) => number
): ApiKeyTotals[] {
  const totalsById = new Map<string, ApiKeyTotals>();
  const totalsByName = new Map<string, ApiKeyTotals[]>();
  for (const apiKey of apiKeys) {
    if (typeof apiKey.id !== "string" || typeof apiKey.name !== "string") continue;
    const totals: ApiKeyTotals = {
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
      requests: 0,
      cost: 0,
      lastUsed: null,
    };
    totalsById.set(apiKey.id, totals);
    totalsByName.set(apiKey.name, [...(totalsByName.get(apiKey.name) || []), totals]);
  }

  const noteLastUsed = (totals: ApiKeyTotals, lastUsed: string | null) => {
    if (lastUsed && (!totals.lastUsed || lastUsed > totals.lastUsed)) totals.lastUsed = lastUsed;
  };
  for (const row of rows) {
    if (!row.apiKeyId) {
      for (const totals of totalsByName.get(row.apiKeyName || "") || []) {
        noteLastUsed(totals, row.lastUsed);
      }
      continue;
    }
    const totals = totalsById.get(row.apiKeyId);
    if (!totals) continue;
    totals.requests += Number(row.requests) || 0;
    totals.cost += rowCost(row);
    noteLastUsed(totals, row.lastUsed);
  }

  return Array.from(totalsById.values(), (totals) => ({
    ...totals,
    cost: roundCost(totals.cost),
  }));
}

/**
 * Per-request pricing memo (upstream #pricing-memoization): one resolution per
 * (provider, model, serviceTier) per response, counted in `misses` for tests.
 */
type PricingResolutionContext = {
  cache: Map<string, Record<string, unknown> | null>;
  misses?: { count: number };
};

function buildPricingCacheKey(provider: string, model: string, serviceTier: string): string {
  return `${provider}\n${model}\n${serviceTier}`;
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
 * the same model's rates, plus a Claude tier anchor, and reports the rest
 * (a `:free` id without its own row therefore resolves to null, #9054).
 */
function resolveModelPricingForRow(
  pricingByProvider: PricingByProvider,
  providerRaw: string,
  model: string,
  serviceTier: string,
  context?: PricingResolutionContext
): Record<string, unknown> | null {
  const key = buildPricingCacheKey(providerRaw, model, serviceTier);
  if (context?.cache.has(key)) return context.cache.get(key) ?? null;
  const resolution = resolveModelPricing(pricingByProvider, providerRaw, model);
  reportMissingPricing(providerRaw, model, resolution.source);
  if (context) {
    context.cache.set(key, resolution.pricing);
    if (context.misses) context.misses.count += 1;
  }
  return resolution.pricing;
}

type UsageRowCostOptions = {
  /** Price at the billed (requested) pair instead of the served one. */
  normalized?: boolean;
  /** The row's own key's model-family multipliers; only scale the normalized figure. */
  multiplierRules?: FamilyMultiplierRule[];
  /** Billed-cost views show flat-rate providers as $0 (default true). */
  flatRateAsZero?: boolean;
  pricingContext?: PricingResolutionContext;
};

function computeUsageRowCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  computeCostFromPricing: ComputeCostFromPricing,
  options: UsageRowCostOptions = {}
): number {
  const { provider, model } = resolveRowPricingPair(row, options.normalized ?? false);
  if (!provider || !model) return 0;
  const flatRateAsZero = options.flatRateAsZero ?? true;
  const serviceTier = normalizeServiceTier(row.serviceTier ?? row.service_tier);
  const isAggregated = toNumber(row.isAggregated ?? row.is_aggregated) > 0;
  const storedCost = toNumber(row.storedCost ?? row.stored_cost);

  // Billed-cost views show flat-rate providers as $0, whatever was stored.
  if (flatRateAsZero && isFlatRateProvider(provider)) return 0;

  let cost: number;
  if (isAggregated && storedCost > 0) {
    // New rollups preserve the exact API-equivalent value calculated before
    // cache/reasoning token dimensions are discarded. Legacy zero-cost rows
    // fall through to the best available input/output-token estimate.
    cost = storedCost;
  } else {
    // Raw rows: `storedCost` is the provider-reported exact cost of the rows that
    // carry one, and the `cost*Tokens` sums exclude those rows' tokens, so a
    // request with a reported cost is never priced a second time from its tokens.
    const rawStoredCost = isAggregated ? 0 : storedCost;
    const pricing = resolveModelPricingForRow(
      pricingByProvider,
      provider,
      model,
      serviceTier,
      options.pricingContext
    );
    cost = pricing
      ? rawStoredCost +
        computeCostFromPricing(
          pricing,
          {
            input: toNumber(row.costPromptTokens ?? row.promptTokens),
            output: toNumber(row.costCompletionTokens ?? row.completionTokens),
            cacheRead: toNumber(row.costCacheReadTokens ?? row.cacheReadTokens),
            cacheCreation: toNumber(row.costCacheCreationTokens ?? row.cacheCreationTokens),
            reasoning: toNumber(row.costReasoningTokens ?? row.reasoningTokens),
            // Share of these sums that came from long-context requests (per-request SQL
            // buckets over the same priceable rows); the tier is never inferred from the
            // sums themselves.
            ...readLongContextColumns(row),
          },
          {
            provider,
            model,
            serviceTier,
            flatRateAsZero,
          }
        )
      : rawStoredCost;
  }

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
  multiplierRules: FamilyMultiplierRule[] = [],
  options: Omit<UsageRowCostOptions, "normalized" | "multiplierRules"> = {}
): number {
  return computeUsageRowCost(row, pricingByProvider, computeCostFromPricing, {
    ...options,
    normalized: true,
    multiplierRules,
  });
}

function computeUsageRowStandardCost(
  row: Record<string, unknown>,
  pricingByProvider: PricingByProvider,
  computeCostFromPricing: ComputeCostFromPricing,
  options: Omit<UsageRowCostOptions, "normalized" | "multiplierRules"> = {}
): number {
  // A raw row's provider-reported cost has no standard-tier alternative to compare
  // against, so it counts the same on both sides and yields no savings. A rollup's
  // stored cost is tier-specific and is re-priced from its tokens instead.
  const keepsReportedCost = toNumber(row.isAggregated ?? row.is_aggregated) === 0;
  const reportedCost = keepsReportedCost ? toNumber(row.storedCost ?? row.stored_cost) : 0;
  return computeUsageRowCost(
    {
      ...row,
      serviceTier: "standard",
      service_tier: "standard",
      storedCost: reportedCost,
      stored_cost: reportedCost,
      isAggregated: 0,
      is_aggregated: 0,
    },
    pricingByProvider,
    computeCostFromPricing,
    options
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
  multiplierRulesForRow: (row: Record<string, unknown>) => FamilyMultiplierRule[],
  costOptions: Omit<UsageRowCostOptions, "normalized" | "multiplierRules"> = {}
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
    existing.cost += computeUsageRowCost(
      row,
      pricingByProvider,
      computeCostFromPricing,
      costOptions
    );
    existing.normalizedCost += computeUsageRowNormalizedCost(
      row,
      pricingByProvider,
      computeCostFromPricing,
      multiplierRulesForRow(row),
      costOptions
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

export async function GET(request: Request, testContext?: unknown) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const misses =
    typeof testContext === "object" &&
    testContext !== null &&
    "misses" in testContext &&
    typeof (testContext as { misses?: unknown }).misses === "object" &&
    (testContext as { misses?: unknown }).misses !== null
      ? (testContext as { misses: { count: number } }).misses
      : undefined;
  return serveAnalyticsCached(new URL(request.url).search, () =>
    computeAnalyticsResponse(request, misses)
  );
}

async function computeAnalyticsResponse(
  request: Request,
  misses?: { count: number }
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "30d";
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const apiKeyIdsParam = searchParams.get("apiKeyIds") || "";
    const apiKeyIds = apiKeyIdsParam ? apiKeyIdsParam.split(",").filter(Boolean) : [];
    // Flat-rate subscriptions are $0 in billed-cost analytics by default. The
    // dedicated costs page opts into their token-price equivalent so subscription
    // consumption can be compared with metered providers without changing budgets.
    const includeFlatRateEstimates = searchParams.get("includeFlatRateEstimates") === "true";
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

    // Raw-data cutoff: must match cleanupUsageHistory's rollup/delete boundary —
    // retention.usageHistory (src/lib/db/cleanup.ts), NOT aggregation.rawDataRetentionDays.
    const dbSettings = getUserDatabaseSettings();
    const rawRetentionDays = dbSettings.retention?.usageHistory ?? 30;
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
    const pricingContext: PricingResolutionContext = {
      cache: new Map(),
      ...(misses ? { misses } : {}),
    };
    // Shared by every cost computation below: flat-rate providers are $0 unless the
    // costs page asked for their estimates, and pricing is memoized per response.
    const costOptions = { flatRateAsZero: !includeFlatRateEstimates, pricingContext };

    const apiKeyWhereClause = appendWhereCondition(
      whereClause,
      "(api_key_id IS NOT NULL AND api_key_id != '') OR (api_key_name IS NOT NULL AND api_key_name != '')"
    );

    // The API Manager key list needs only per-key totals. Skip the full report,
    // whose queries hold the event loop for seconds on large usage_history tables.
    if (searchParams.get("view") === "apiKeys") {
      const byApiKey = buildApiKeyTotals(
        getApiKeyTotalsRows(apiKeyWhereClause, params),
        apiKeys,
        (row) =>
          computeUsageRowCost(
            row as unknown as Record<string, unknown>,
            pricingByProvider,
            computeCostFromPricing,
            costOptions
          )
      );
      return NextResponse.json({ byApiKey });
    }

    const summaryRow = getUsageSummary(unifiedSource, unifiedParams) as Record<string, unknown>;

    const dailyRows = getDailyUsage(unifiedSource, unifiedParams) as UsageRows;
    const dailyCostRows = getDailyCostRows(unifiedSource, unifiedParams) as UsageRows;

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

    const heatmapRows = getHeatmapRows(heatmapConditions, heatmapParams) as UsageRows;

    const modelRows = getModelUsageRows(unifiedSource, unifiedParams) as UsageRows;

    const providerCostRows = getProviderCostRows(unifiedSource, unifiedParams) as UsageRows;

    const providerRows = getProviderUsageRows(unifiedSource, unifiedParams) as UsageRows;

    const accountCostWhereClause = whereClause
      .replace(/timestamp/g, "usage_history.timestamp")
      .replace(/api_key_/g, "usage_history.api_key_");
    const accountCostRows = getAccountCostRows(accountCostWhereClause, params) as UsageRows;

    const accountRows = getAccountUsageRows(accountCostWhereClause, params) as UsageRows;

    const apiKeyRows = getApiKeyUsageRows(apiKeyWhereClause, params) as UsageRows;

    const serviceTierRows = getServiceTierUsageRows(unifiedSource, unifiedParams) as UsageRows;

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

    const apiKeyMetadataRows = getApiKeyMetadataRows(apiKeyWhereClause, params) as UsageRows;

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

    const weeklyRows = getWeeklyPatternRows(unifiedSource, unifiedParams) as UsageRows;

    const fallbackRow = getFallbackStats(whereClause, params) as Record<string, unknown>;
    const errorBreakdown = getErrorTypeBreakdown(whereClause, params);

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
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing, costOptions);
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

    // Volume counted under BOTH identities, independent of `costBasis`.
    //
    // `requests`/`totalTokens` below follow the active basis, so in `real` they are
    // served-side and in `billed` they are requested-side — which makes a redirected
    // row visible only by flipping the toggle and diffing two screens by hand. These
    // two maps let a single row carry both, so `claude-sonnet-5` can read
    // "721 served / 286 requested" without changing view. Keyed the same way the
    // bucket is (normalized model name), so the lookup is exact rather than by label.
    const servedVolumeByKey = new Map<string, { requests: number; totalTokens: number }>();
    const requestedVolumeByKey = new Map<string, { requests: number; totalTokens: number }>();
    for (const row of modelRows) {
      const realModel = row.model as string;
      const realProvider = row.provider as string;
      if (!realModel || !realProvider) continue;
      const requestedModel = toStringValue(row.billedModel) || realModel;
      const requests = Number(row.requests) || 0;
      const totalTokens = Number(row.totalTokens) || 0;

      for (const [map, key] of [
        [servedVolumeByKey, normalizeModelName(realModel)],
        [requestedVolumeByKey, normalizeModelName(requestedModel)],
      ] as const) {
        const bucket = map.get(key) || { requests: 0, totalTokens: 0 };
        bucket.requests += requests;
        bucket.totalTokens += totalTokens;
        map.set(key, bucket);
      }
    }

    const modelMap = new Map<string, Record<string, unknown>>();
    for (const row of modelRows) {
      const realModel = row.model as string;
      const realProvider = row.provider as string;
      // `costBasis=real` (default) groups by the served pair. `costBasis=billed`
      // groups by what the client asked for, so a redirected row's
      // requests/tokens/cost land in the REQUESTED family's bucket instead of the
      // family that actually ran.
      const groupProvider =
        costBasis === "billed" ? toStringValue(row.billedProvider) || realProvider : realProvider;
      const groupModel =
        costBasis === "billed" ? toStringValue(row.billedModel) || realModel : realModel;
      const short = normalizeModelName(groupModel);
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing, costOptions);
      const normalizedCost = computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row),
        costOptions
      );
      // Keyed by model name alone (not provider) — the table renders one row per
      // model, so the same model served via multiple provider connections/accounts
      // must be merged here rather than producing duplicate `key={m.model}` rows.
      const key = short;
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
      .map((row) => {
        const volumeKey = toStringValue(row.model);
        const served = servedVolumeByKey.get(volumeKey);
        const requested = requestedVolumeByKey.get(volumeKey);
        return {
          model: row.model,
          provider: row.provider,
          rawModel: row.rawModel,
          requests: Number(row.requests),
          /** Requests that actually RAN on this model, whatever the client asked for. */
          servedRequests: served?.requests ?? 0,
          /** Requests the client ASKED for under this identity, whatever ran. */
          requestedRequests: requested?.requests ?? 0,
          servedTotalTokens: served?.totalTokens ?? 0,
          requestedTotalTokens: requested?.totalTokens ?? 0,
          promptTokens: Number(row.promptTokens),
          completionTokens: Number(row.completionTokens),
          totalTokens: Number(row.totalTokens),
          avgLatencyMs:
            Number(row.requests) > 0
              ? Math.round(Number(row.latencyWeightedTotal || 0) / Number(row.requests))
              : 0,
          successRatePct:
            Number(row.requests) > 0
              ? Number((Number(row.successfulRequests || 0) / Number(row.requests)) * 100).toFixed(
                  2
                )
              : 0,
          lastUsed: row.lastUsed,
          cost: roundCost(Number(row.cost || 0)),
          normalizedCost: roundCost(Number(row.normalizedCost || 0)),
        };
      })
      .sort((left, right) => Number(right.requests) - Number(left.requests))
      .slice(0, 50);

    const totalCost = Array.from(dailyCostByDate.values()).reduce((sum, cost) => sum + cost, 0);
    summary.totalCost = roundCost(totalCost);

    const providerCostByProvider = new Map<string, number>();
    const providerNormalizedCostByProvider = new Map<string, number>();
    for (const row of providerCostRows) {
      const provider = toStringValue(row.provider);
      if (!provider) continue;
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing, costOptions);
      const normalizedCost = computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row),
        costOptions
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
    // unchanged. costBasis=billed instead re-derives provider-level requests/
    // tokens/latency/success from `modelRows`, which already carries
    // billed_provider per row at a finer grain than provider-only — summing it
    // back up to provider level is a strict coarsening of the same rows, so it's
    // exact, not an approximation. Both carry the display name in `provider`
    // (#7534) and the raw id in `providerId`.
    let byProvider: Array<Record<string, unknown>>;
    if (costBasis === "billed") {
      const displayName = await getProviderDisplayNameResolver();
      byProvider = buildBilledProviderRows(
        modelRows,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow,
        costOptions
      ).map((row) => ({ ...row, provider: displayName(row.provider), providerId: row.provider }));
    } else {
      byProvider = (await buildByProviderRows(providerRows, providerCostByProvider)).map((row) => ({
        ...row,
        normalizedCost: roundCost(providerNormalizedCostByProvider.get(row.providerId) || 0),
      }));
    }

    const accountCostByAccount = new Map<string, number>();
    const accountNormalizedCostByAccount = new Map<string, number>();
    for (const row of accountCostRows) {
      const accountKey = toStringValue(row.accountKey, "unknown");
      const cost = computeUsageRowCost(row, pricingByProvider, computeCostFromPricing, costOptions);
      const normalizedCost = computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row),
        costOptions
      );
      accountCostByAccount.set(accountKey, (accountCostByAccount.get(accountKey) || 0) + cost);
      accountNormalizedCostByAccount.set(
        accountKey,
        (accountNormalizedCostByAccount.get(accountKey) || 0) + normalizedCost
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
      cost: roundCost(accountCostByAccount.get(toStringValue(row.accountKey, "unknown")) || 0),
      normalizedCost: roundCost(
        accountNormalizedCostByAccount.get(toStringValue(row.accountKey, "unknown")) || 0
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
      existing.cost += computeUsageRowCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        costOptions
      );
      existing.normalizedCost += computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row),
        costOptions
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
      const actualCost = computeUsageRowCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        costOptions
      );
      existing.cost += actualCost;
      existing.normalizedCost += computeUsageRowNormalizedCost(
        row,
        pricingByProvider,
        computeCostFromPricing,
        multiplierRulesForRow(row),
        costOptions
      );
      if (serviceTier === "flex") {
        const standardCost = computeUsageRowStandardCost(
          row,
          pricingByProvider,
          computeCostFromPricing,
          costOptions
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

    const modelNames = Array.from(allModels);
    const dailyByModel = Object.keys(dailyByModelMap)
      .sort()
      .map((date) => ({
        date,
        ...Object.fromEntries(
          modelNames.map((model) => [model, dailyByModelMap[date][model] || 0])
        ),
      }));

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
      errorBreakdown,
      range,
      includesFlatRateEstimates: includeFlatRateEstimates,
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
        const { unifiedSource: pSrc, unifiedParams: pParams } = buildPresetUnifiedSource({
          sinceIso: presetSinceIso ?? null,
          untilIso: null,
          rawCutoffDate,
          apiKeyWhere,
          apiKeyParams: apiKeyParamEntries,
        });

        const presetModelRows = getPresetCostModelRows(pSrc, pParams) as UsageRows;

        let presetTotalCost = 0;
        for (const row of presetModelRows) {
          presetTotalCost += computeUsageRowCost(
            row,
            pricingByProvider,
            computeCostFromPricing,
            costOptions
          );
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
