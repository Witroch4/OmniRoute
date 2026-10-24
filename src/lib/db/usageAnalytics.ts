/**
 * db/usageAnalytics.ts — Read-only aggregation queries over `usage_history`
 * and `daily_usage_summary` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/usage/analytics and /api/settings/export-json routes can delegate.
 * Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (usage_history / daily_usage_summary cluster).
 */

import { getDbInstance } from "./core";
import {
  PRICED_FROM_TOKENS_SQL,
  longContextSumColumns,
  longContextSumOfRowColumns,
} from "../usage/longContextSql";
import type { AnalyticsParams } from "./usageAnalytics/sources";

export { buildUnifiedSource, buildPresetUnifiedSource } from "./usageAnalytics/sources";
export type {
  AnalyticsParams,
  BuildUnifiedSourceOptions,
  UnifiedSourceResult,
} from "./usageAnalytics/sources";

/**
 * Priceable-token sums over a unified source (see RAW_COST_COLUMNS in
 * ./usageAnalytics/sources). The display token sums stay untouched; cost is the
 * stored cost plus these tokens priced, so a row with a provider-reported cost is
 * never priced a second time.
 */
const UNIFIED_COST_TOKEN_SUMS = `
        COALESCE(SUM(cost_tokens_input), 0) as costPromptTokens,
        COALESCE(SUM(cost_tokens_output), 0) as costCompletionTokens,
        COALESCE(SUM(cost_tokens_cache_read), 0) as costCacheReadTokens,
        COALESCE(SUM(cost_tokens_cache_creation), 0) as costCacheCreationTokens,
        COALESCE(SUM(cost_tokens_reasoning), 0) as costReasoningTokens`;

/** The same split for queries that read usage_history directly. */
function rawCostSums(table: string): string {
  const priceable = (column: string) =>
    `COALESCE(SUM(CASE WHEN ${table}.provider_cost_usd IS NULL THEN ${table}.${column} ELSE 0 END), 0)`;
  return `
        COALESCE(SUM(${table}.provider_cost_usd), 0.0) as storedCost,
        0 as isAggregated,
        ${priceable("tokens_input")} as costPromptTokens,
        ${priceable("tokens_output")} as costCompletionTokens,
        ${priceable("tokens_cache_read")} as costCacheReadTokens,
        ${priceable("tokens_cache_creation")} as costCacheCreationTokens,
        ${priceable("tokens_reasoning")} as costReasoningTokens`;
}

/** Priceable-token fields carried by every cost row. */
export interface CostTokenFields {
  costPromptTokens: number;
  costCompletionTokens: number;
  costCacheReadTokens: number;
  costCacheCreationTokens: number;
  costReasoningTokens: number;
}

// ---------------------------------------------------------------------------
// Analytics summary — /api/usage/analytics
// ---------------------------------------------------------------------------

export interface UsageSummaryRow {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  uniqueModels: number;
  uniqueAccounts: number;
  uniqueApiKeys: number;
  successfulRequests: number;
  avgLatencyMs: number;
  firstRequest: string;
  lastRequest: string;
}

/**
 * Scalar summary over the unified source CTE.
 *
 * @param unifiedSource - Pre-built subquery string (UNION of raw + aggregated rows).
 * @param params        - Named params referenced inside `unifiedSource`.
 */
export function getUsageSummary(unifiedSource: string, params: AnalyticsParams): UsageSummaryRow {
  const db = getDbInstance();
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(requests), 0) as totalRequests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COUNT(DISTINCT model) as uniqueModels,
        COUNT(DISTINCT COALESCE(NULLIF(account_key, ''), NULLIF(connection_id, ''))) as uniqueAccounts,
        COUNT(DISTINCT COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''))) as uniqueApiKeys,
        COALESCE(SUM(CASE WHEN success = 1 THEN requests ELSE 0 END), 0) as successfulRequests,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(MIN(timestamp), '') as firstRequest,
        COALESCE(MAX(timestamp), '') as lastRequest
      FROM ${unifiedSource} AS _u
    `
    )
    .get(params) as UsageSummaryRow | undefined;
  return (
    row ?? {
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      uniqueModels: 0,
      uniqueAccounts: 0,
      uniqueApiKeys: 0,
      successfulRequests: 0,
      avgLatencyMs: 0,
      firstRequest: "",
      lastRequest: "",
    }
  );
}

// ---------------------------------------------------------------------------

export interface DailyUsageRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Daily request + token counts aggregated from the unified source CTE.
 */
export function getDailyUsage(unifiedSource: string, params: AnalyticsParams): DailyUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        DATE(timestamp) as date,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `
    )
    .all(params) as DailyUsageRow[];
}

// ---------------------------------------------------------------------------

export interface DailyCostRow extends CostTokenFields {
  date: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-day, per-provider, per-model token breakdown for cost calculation.
 */
export function getDailyCostRows(unifiedSource: string, params: AnalyticsParams): DailyCostRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        DATE(timestamp) as date,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumOfRowColumns()},
        COALESCE(SUM(stored_cost), 0.0) as storedCost,
        MAX(is_aggregated) as isAggregated,
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), LOWER(provider), LOWER(model), serviceTier
      ORDER BY date ASC
    `
    )
    .all(params) as DailyCostRow[];
}

// ---------------------------------------------------------------------------

export interface HeatmapRow {
  date: string;
  totalTokens: number;
}

/**
 * Per-day token totals for the activity heatmap.
 * Uses `usage_history` directly (not the unified CTE) since the heatmap has its
 * own independent time window and api_key filter.
 *
 * @param heatmapConditions - Array of SQL condition strings (combined with AND).
 * @param params            - Named params referenced inside the conditions.
 */
export function getHeatmapRows(heatmapConditions: string[], params: AnalyticsParams): HeatmapRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        DATE(timestamp) as date,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM usage_history
      WHERE ${heatmapConditions.join(" AND ")}
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `
    )
    .all(params) as HeatmapRow[];
}

// ---------------------------------------------------------------------------

export interface ModelUsageRow extends CostTokenFields {
  model: string;
  provider: string;
  serviceTier: string;
  billedModel: string | null;
  billedProvider: string | null;
  /** NULL when this row came from the rolled-up `daily_usage_summary` leg (key
   * attribution is dropped on rollup) OR the request had no api key. See the
   * doc comment below and `resolveFamilyMultiplier`'s per-row callers in
   * `src/app/api/usage/analytics/route.ts` — a NULL here means the
   * per-key model-family multiplier (migration 128) cannot be resolved for
   * this row and it is priced neutrally, flagged via the response's
   * `normalizedCostCoverage`. */
  apiKeyId: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-model usage aggregates from the unified source CTE.
 *
 * Grouped an extra level by (billed_provider, billed_model) — the pair a
 * model-budget rule redirected FROM — so `computeUsageRowCost` can be called
 * a second time per row with those columns to produce the normalized total
 * (#omniroute-model-budget-family-routing Task 11). Real (provider, model)
 * grouping is unchanged; callers that only merge rows by real model see the
 * same totals as before, just spread over more source rows.
 *
 * Grouped an additional extra level by `api_key_id` (final-review Finding 2,
 * family-multiplier fix-round) so the route can resolve each row's OWN key's
 * model-family multiplier before re-merging into the final by-model total —
 * a merged row spanning several keys can never be scaled by a single key's
 * multiplier correctly. `apiKeyId` is NULL for `daily_usage_summary` rows
 * (rollup drops per-key attribution by design, see `sources.ts`) or requests
 * with no api key; those rows price neutrally and the gap is surfaced via
 * `normalizedCostCoverage`, never silently absorbed into the total. This
 * extra grouping dimension is arithmetically transparent to every OTHER
 * consumer: cost/token sums are linear in tokens, so re-merging finer rows by
 * (provider, model, ...) produces byte-identical totals to before.
 */
export function getModelUsageRows(unifiedSource: string, params: AnalyticsParams): ModelUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        LOWER(NULLIF(billed_model, '')) as billedModel,
        LOWER(NULLIF(billed_provider, '')) as billedProvider,
        NULLIF(api_key_id, '') as apiKeyId,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumOfRowColumns()},
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN requests ELSE 0 END), 0) as successfulRequests,
        COALESCE(MAX(timestamp), '') as lastUsed,
        COALESCE(SUM(stored_cost), 0.0) as storedCost,
        MAX(is_aggregated) as isAggregated,
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      -- Keep cost inputs separated by day. Historical provider rows do not
      -- always use one cache-token convention, and computeCostFromPricing's
      -- non-cached-input clamp is intentionally non-linear across those rows.
      GROUP BY DATE(timestamp), LOWER(model), LOWER(provider), serviceTier, LOWER(NULLIF(billed_model, '')), LOWER(NULLIF(billed_provider, '')), NULLIF(api_key_id, '')
      ORDER BY requests DESC
    `
    )
    .all(params) as ModelUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ProviderCostRow extends CostTokenFields {
  provider: string;
  model: string;
  serviceTier: string;
  billedModel: string | null;
  billedProvider: string | null;
  /** See the doc comment on `ModelUsageRow.apiKeyId` — same NULL-on-rollup contract. */
  apiKeyId: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-provider, per-model token breakdown for provider cost calculation.
 * Also grouped by (billed_provider, billed_model) — see the note on
 * `getModelUsageRows` — so callers can price the normalized total alongside
 * the real one without a second aggregation pass. Also grouped by
 * `api_key_id` (final-review Finding 2) — same per-key multiplier
 * resolution rationale as `getModelUsageRows`.
 */
export function getProviderCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): ProviderCostRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        LOWER(NULLIF(billed_model, '')) as billedModel,
        LOWER(NULLIF(billed_provider, '')) as billedProvider,
        NULLIF(api_key_id, '') as apiKeyId,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumOfRowColumns()},
        COALESCE(SUM(stored_cost), 0.0) as storedCost,
        MAX(is_aggregated) as isAggregated,
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), LOWER(provider), LOWER(model), serviceTier, LOWER(NULLIF(billed_model, '')), LOWER(NULLIF(billed_provider, '')), NULLIF(api_key_id, '')
    `
    )
    .all(params) as ProviderCostRow[];
}

// ---------------------------------------------------------------------------

export interface ProviderUsageRow {
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
}

/**
 * Per-provider usage aggregates from the unified source CTE.
 */
export function getProviderUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): ProviderUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        LOWER(provider) as provider,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN requests ELSE 0 END), 0) as successfulRequests
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(provider)
      ORDER BY requests DESC
    `
    )
    .all(params) as ProviderUsageRow[];
}

// ---------------------------------------------------------------------------

export interface AccountCostRow extends CostTokenFields {
  accountKey: string;
  provider: string;
  model: string;
  serviceTier: string;
  billedModel: string | null;
  billedProvider: string | null;
  /** See the doc comment on `ModelUsageRow.apiKeyId`. Always sourced straight from
   * `usage_history` here (this query never reads the rolled-up leg), so NULL only
   * means "this request had no api key attached", not a rollup gap. */
  apiKeyId: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-account cost breakdown grouped by the identity snapshot stored on each usage event.
 * Also grouped by (billed_provider, billed_model) and `api_key_id` (final-review
 * Finding 2) — same per-key multiplier resolution rationale as `getModelUsageRows`.
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export function getAccountCostRows(whereClause: string, params: AnalyticsParams): AccountCostRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      WITH account_events AS (
        SELECT
          COALESCE(
            NULLIF(usage_history.account_key, ''),
            'connection:' || COALESCE(LOWER(usage_history.provider), 'unknown') || ':' || COALESCE(NULLIF(TRIM(usage_history.connection_id), ''), 'unknown')
          ) as resolved_account_key,
          usage_history.provider,
          usage_history.model,
          usage_history.service_tier,
          usage_history.timestamp,
          usage_history.tokens_input,
          usage_history.tokens_output,
          usage_history.tokens_cache_read,
          usage_history.tokens_cache_creation,
          usage_history.tokens_reasoning,
          usage_history.provider_cost_usd,
          usage_history.billed_model,
          usage_history.billed_provider,
          usage_history.api_key_id
        FROM usage_history
        ${whereClause}
      )
      SELECT
        account_events.resolved_account_key as accountKey,
        LOWER(account_events.provider) as provider,
        LOWER(account_events.model) as model,
        COALESCE(NULLIF(account_events.service_tier, ''), 'standard') as serviceTier,
        LOWER(NULLIF(account_events.billed_model, '')) as billedModel,
        LOWER(NULLIF(account_events.billed_provider, '')) as billedProvider,
        NULLIF(account_events.api_key_id, '') as apiKeyId,
        COALESCE(SUM(account_events.tokens_input), 0) as promptTokens,
        COALESCE(SUM(account_events.tokens_output), 0) as completionTokens,
        COALESCE(SUM(account_events.tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(account_events.tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(account_events.tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumColumns("account_events.", undefined, undefined, `account_events.${PRICED_FROM_TOKENS_SQL}`)},
        ${rawCostSums("account_events")}
      FROM account_events
      GROUP BY DATE(account_events.timestamp), accountKey, LOWER(account_events.provider), LOWER(account_events.model), serviceTier, LOWER(NULLIF(account_events.billed_model, '')), LOWER(NULLIF(account_events.billed_provider, '')), NULLIF(account_events.api_key_id, '')
    `
    )
    .all(params) as AccountCostRow[];
}

// ---------------------------------------------------------------------------

export interface AccountUsageRow {
  accountKey: string;
  account: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  lastUsed: string;
}

/**
 * Per-account usage aggregates grouped by the identity snapshot stored on each usage event.
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export function getAccountUsageRows(
  whereClause: string,
  params: AnalyticsParams
): AccountUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      WITH account_events AS (
        SELECT
          usage_history.*,
          COALESCE(NULLIF(usage_history.account_key, ''), 'connection:' || COALESCE(LOWER(usage_history.provider), 'unknown') || ':' || COALESCE(NULLIF(TRIM(usage_history.connection_id), ''), 'unknown')) as resolved_account_key
        FROM usage_history
        ${whereClause}
      ),
      stable_account_keys AS (
        SELECT DISTINCT account_key
        FROM account_events
        WHERE account_key > ''
      ),
      stable_labels AS (
        SELECT
          stable_account_keys.account_key,
          (
            SELECT TRIM(usage_history.account_label)
            FROM usage_history
            WHERE usage_history.account_key = stable_account_keys.account_key
              AND NULLIF(TRIM(usage_history.account_label), '') IS NOT NULL
            ORDER BY COALESCE(usage_history.account_label_priority, 0) DESC,
                     usage_history.timestamp DESC,
                     usage_history.id DESC
            LIMIT 1
          ) as account_label
        FROM stable_account_keys
      ),
      legacy_labels AS (
        SELECT account_key, account_label
        FROM (
          SELECT
            account_events.resolved_account_key as account_key,
            TRIM(account_events.account_label) as account_label,
            ROW_NUMBER() OVER (
              PARTITION BY account_events.resolved_account_key
              ORDER BY COALESCE(account_events.account_label_priority, 0) DESC,
                       account_events.timestamp DESC,
                       account_events.id DESC
            ) as label_rank
          FROM account_events
          WHERE (account_events.account_key IS NULL OR account_events.account_key = '')
            AND NULLIF(TRIM(account_events.account_label), '') IS NOT NULL
        )
        WHERE label_rank = 1
      ),
      selected_labels AS (
        SELECT account_key, account_label FROM stable_labels
        UNION ALL
        SELECT account_key, account_label FROM legacy_labels
      )
      SELECT
        account_events.resolved_account_key as accountKey,
        COALESCE(NULLIF(TRIM(selected_labels.account_label), ''), NULLIF(TRIM(account_events.connection_id), ''), 'unknown') as account,
        COUNT(account_events.id) as requests,
        COALESCE(SUM(account_events.tokens_input), 0) as promptTokens,
        COALESCE(SUM(account_events.tokens_output), 0) as completionTokens,
        COALESCE(SUM(account_events.tokens_input + account_events.tokens_output), 0) as totalTokens,
        COALESCE(AVG(account_events.latency_ms), 0) as avgLatencyMs,
        COALESCE(MAX(account_events.timestamp), '') as lastUsed
      FROM account_events
      LEFT JOIN selected_labels
        ON selected_labels.account_key = account_events.resolved_account_key
      GROUP BY accountKey
      ORDER BY requests DESC
      LIMIT 50
    `
    )
    .all(params) as AccountUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ApiKeyUsageRow extends CostTokenFields {
  apiKeyId: string | null;
  apiKeyGroupKey: string;
  provider: string;
  model: string;
  serviceTier: string;
  billedModel: string | null;
  billedProvider: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-API-key usage aggregates from usage_history.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export function getApiKeyUsageRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): ApiKeyUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        LOWER(NULLIF(billed_model, '')) as billedModel,
        LOWER(NULLIF(billed_provider, '')) as billedProvider,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumColumns("", undefined, undefined, PRICED_FROM_TOKENS_SQL)},
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        ${rawCostSums("usage_history")}
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY DATE(timestamp), COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown'), NULLIF(api_key_id, ''), LOWER(provider), LOWER(model), serviceTier, LOWER(NULLIF(billed_model, '')), LOWER(NULLIF(billed_provider, ''))
    `
    )
    .all(params) as ApiKeyUsageRow[];
}

export interface ApiKeyTotalsRow extends CostTokenFields {
  apiKeyId: string | null;
  apiKeyName: string | null;
  provider: string;
  model: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  lastUsed: string | null;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-API-key totals and last-used time in a single scan, without the per-day
 * grouping of `getApiKeyUsageRows`. Backs the API Manager key list, which only
 * needs lifetime requests, cost and last use per key.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export function getApiKeyTotalsRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): ApiKeyTotalsRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        NULLIF(api_key_name, '') as apiKeyName,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        MAX(timestamp) as lastUsed,
        ${longContextSumColumns("", undefined, undefined, PRICED_FROM_TOKENS_SQL)},
        ${rawCostSums("usage_history")}
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), LOWER(provider), LOWER(model), serviceTier
    `
    )
    .all(params) as ApiKeyTotalsRow[];
}

// ---------------------------------------------------------------------------
// Per-device usage — /api/usage/devices (migration 171 client_ip)
// ---------------------------------------------------------------------------

export interface ApiKeyDeviceUsageRow {
  apiKeyId: string;
  apiKeyName: string | null;
  clientIp: string | null;
  provider: string | null;
  model: string | null;
  serviceTier: string;
  requests: number;
  succeeded: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  lcPromptTokens: number;
  lcCompletionTokens: number;
  lcCacheReadTokens: number;
  lcCacheCreationTokens: number;
  lcReasoningTokens: number;
  lastSeen: string;
}

export interface ApiKeyDeviceUsageParams {
  since: string;
  until: string;
  apiKeyId: string | null;
}

/**
 * Usage per API key x client tailnet IP x provider/model/tier in `[since, until)`.
 * Rows without a client IP (history before migration 171) group under `clientIp: null`.
 * Carries the long-context token split so callers can price each row per request tier.
 */
export function getApiKeyDeviceUsageRows(params: ApiKeyDeviceUsageParams): ApiKeyDeviceUsageRow[] {
  return getDbInstance()
    .prepare(
      `SELECT api_key_id as apiKeyId, MAX(api_key_name) as apiKeyName, client_ip as clientIp,
              LOWER(provider) as provider, LOWER(model) as model,
              COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
              COUNT(*) as requests, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as succeeded,
              COALESCE(SUM(tokens_input), 0) as promptTokens,
              COALESCE(SUM(tokens_output), 0) as completionTokens,
              COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
              COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
              COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
              ${longContextSumColumns()},
              MAX(timestamp) as lastSeen
         FROM usage_history
        WHERE timestamp >= @since AND timestamp < @until
          AND api_key_id IS NOT NULL
          AND (@apiKeyId IS NULL OR api_key_id = @apiKeyId)
        GROUP BY api_key_id, client_ip, LOWER(provider), LOWER(model), serviceTier`
    )
    .all({
      since: params.since,
      until: params.until,
      apiKeyId: params.apiKeyId,
    }) as ApiKeyDeviceUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ServiceTierUsageRow extends CostTokenFields {
  serviceTier: string;
  provider: string;
  model: string;
  billedModel: string | null;
  billedProvider: string | null;
  /** See the doc comment on `ModelUsageRow.apiKeyId` — same NULL-on-rollup contract. */
  apiKeyId: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-service-tier, per-provider, per-model usage aggregates. Also grouped by
 * `api_key_id` (final-review Finding 2) — same per-key multiplier resolution
 * rationale as `getModelUsageRows`.
 */
export function getServiceTierUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): ServiceTierUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        LOWER(provider) as provider,
        LOWER(model) as model,
        LOWER(NULLIF(billed_model, '')) as billedModel,
        LOWER(NULLIF(billed_provider, '')) as billedProvider,
        NULLIF(api_key_id, '') as apiKeyId,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumOfRowColumns()},
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(SUM(stored_cost), 0.0) as storedCost,
        MAX(is_aggregated) as isAggregated,
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), serviceTier, LOWER(provider), LOWER(model), LOWER(NULLIF(billed_model, '')), LOWER(NULLIF(billed_provider, '')), NULLIF(api_key_id, '')
    `
    )
    .all(params) as ServiceTierUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ApiKeyMetadataRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyGroupKey: string;
  lastUsed: string;
}

/**
 * Latest API key name + group key from usage_history for display metadata.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export function getApiKeyMetadataRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): ApiKeyMetadataRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        NULLIF(api_key_name, '') as apiKeyName,
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
        MAX(timestamp) as lastUsed
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, '')
      ORDER BY lastUsed DESC
    `
    )
    .all(params) as ApiKeyMetadataRow[];
}

// ---------------------------------------------------------------------------

export interface WeeklyPatternRow {
  dayOfWeek: string;
  days: number;
  requests: number;
  totalTokens: number;
}

/**
 * Day-of-week aggregates for the weekly activity pattern chart.
 */
export function getWeeklyPatternRows(
  unifiedSource: string,
  params: AnalyticsParams
): WeeklyPatternRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        dayOfWeek,
        COUNT(*) as days,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(totalTokens), 0) as totalTokens
      FROM (
        SELECT
          DATE(timestamp) as date,
          strftime('%w', timestamp) as dayOfWeek,
          COALESCE(SUM(requests), 0) as requests,
          COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
        FROM ${unifiedSource} AS _u
        GROUP BY DATE(timestamp), strftime('%w', timestamp)
      )
      GROUP BY dayOfWeek
      ORDER BY dayOfWeek ASC
    `
    )
    .all(params) as WeeklyPatternRow[];
}

// ---------------------------------------------------------------------------

export interface PresetCostModelRow extends CostTokenFields {
  model: string;
  provider: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-model token breakdown for preset range cost calculation.
 * Uses a preset-specific unified source (may differ from the main query window).
 */
export function getPresetCostModelRows(
  presetUnifiedSource: string,
  params: AnalyticsParams
): PresetCostModelRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumOfRowColumns()},
        COALESCE(SUM(stored_cost), 0.0) as storedCost,
        MAX(is_aggregated) as isAggregated,
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${presetUnifiedSource} AS _pu
      GROUP BY DATE(timestamp), LOWER(model), LOWER(provider), serviceTier
    `
    )
    .all(params) as PresetCostModelRow[];
}

// ---------------------------------------------------------------------------
// Endpoint dimension — ported from decolua/9router#152 (thanks @toanalien).
// Reads directly from usage_history (raw rows) so the unified CTE stays
// untouched; matches the pattern used by getAutoRoutingVariantBreakdown.
// ---------------------------------------------------------------------------

export interface EndpointUsageRow {
  endpoint: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
}

export interface EndpointUsageParams {
  sinceIso?: string | null;
  untilIso?: string | null;
}

/**
 * Per-endpoint × provider × model usage aggregates from `usage_history`.
 * NULL endpoints fold into the 'unknown' bucket so legacy rows stay visible.
 *
 * Inspired by decolua/9router#152 (byEndpoint aggregation), reshaped for the
 * OmniRoute SQLite schema + analytics conventions.
 */
export function getEndpointUsageRows(params: EndpointUsageParams = {}): EndpointUsageRow[] {
  const db = getDbInstance();
  const conditions: string[] = [];
  const bind: Record<string, unknown> = {};
  if (params.sinceIso) {
    conditions.push("timestamp >= @since");
    bind.since = params.sinceIso;
  }
  if (params.untilIso) {
    conditions.push("timestamp <= @until");
    bind.until = params.untilIso;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `
      SELECT
        COALESCE(NULLIF(endpoint, ''), 'unknown') as endpoint,
        LOWER(COALESCE(provider, 'unknown')) as provider,
        LOWER(COALESCE(model, 'unknown')) as model,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        ${longContextSumColumns()},
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(MAX(timestamp), '') as lastUsed
      FROM usage_history
      ${whereSql}
      GROUP BY endpoint, LOWER(COALESCE(provider, 'unknown')), LOWER(COALESCE(model, 'unknown'))
      ORDER BY requests DESC
    `
    )
    .all(bind) as EndpointUsageRow[];
}

// ---------------------------------------------------------------------------
// Request count per provider, per date — #4009
// ---------------------------------------------------------------------------

export interface ProviderDailyUsageRow {
  date: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Per-day, per-provider request counts + token totals from the unified source CTE.
 * Answers "how many requests did provider X get on date Y" (#4009) — providers that
 * bill per-request rather than per-token need this breakdown, not just the
 * per-provider aggregate (`getProviderUsageRows`) or the per-day aggregate
 * (`getDailyUsage`).
 */
export function getProviderDailyUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): ProviderDailyUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
      SELECT
        DATE(timestamp) as date,
        LOWER(provider) as provider,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), LOWER(provider)
      ORDER BY date DESC, requests DESC
    `
    )
    .all(params) as ProviderDailyUsageRow[];
}

// ---------------------------------------------------------------------------
// Export-JSON backup — /api/settings/export-json
// ---------------------------------------------------------------------------

/**
 * Returns all rows from `usage_history` for backup export.
 * Only called when `?includeHistory=true` is explicitly requested.
 */
export function getAllUsageHistory(): Record<string, unknown>[] {
  const db = getDbInstance();
  return db.prepare("SELECT * FROM usage_history").all() as Record<string, unknown>[];
}

/**
 * Returns all rows from `domain_cost_history` for backup export.
 */
export function getAllDomainCostHistory(): Record<string, unknown>[] {
  const db = getDbInstance();
  return db.prepare("SELECT * FROM domain_cost_history").all() as Record<string, unknown>[];
}

/**
 * Returns all rows from `domain_budgets` for backup export.
 */
export function getAllDomainBudgets(): Record<string, unknown>[] {
  const db = getDbInstance();
  return db.prepare("SELECT * FROM domain_budgets").all() as Record<string, unknown>[];
}
