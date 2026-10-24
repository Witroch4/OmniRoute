/**
 * SQL + row helpers for long-context pricing (see `LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS`).
 *
 * Grouped cost queries (`SUM(tokens_*) ... GROUP BY model`) cannot decide the tier from
 * the sums: a week of small requests adds up past the threshold and would bill at the
 * long-context rate. Instead each such query also selects the portion of every token
 * column that came from individual requests over the threshold. The group keys and row
 * count stay the same, so consumers that merge or map rows are unaffected; the cost
 * function prices the long part at the tier rates and the rest at base rates.
 *
 * One split is selected per threshold in `LONG_CONTEXT_SQL_THRESHOLDS`: the default
 * (100K, exclusive — rows without an explicit threshold) keeps the legacy `lc*` names, the
 * others (upstream's explicit tiers: xAI >=200K, OpenAI >272K) get the same names with the
 * tier key appended (`lcPromptTokens_272000`, `lc_input_200000i`). The cost function picks
 * the split that matches the pricing row's own threshold.
 *
 * @module lib/usage/longContextSql
 */

import {
  LONG_CONTEXT_SQL_THRESHOLDS,
  longContextTierKey,
  type LongContextSplit,
  type LongContextThreshold,
  type LongContextTokens,
} from "./costCalculator";

/** Token column names of a table; `usage_history` unless the table names them differently. */
export type TokenColumnNames = {
  input: string;
  output: string;
  cacheRead: string;
  cacheCreation: string;
  reasoning: string;
};

const USAGE_HISTORY_COLUMNS: TokenColumnNames = {
  input: "tokens_input",
  output: "tokens_output",
  cacheRead: "tokens_cache_read",
  cacheCreation: "tokens_cache_creation",
  reasoning: "tokens_reasoning",
};

/**
 * Rows the cost paths price from tokens: one carrying a provider-reported exact cost
 * (`provider_cost_usd`, upstream migration 212) is billed by that cost instead, so its
 * tokens must not land in the long-context split either.
 */
export const PRICED_FROM_TOKENS_SQL = "provider_cost_usd IS NULL";

/** `call_logs` abbreviates the first two. */
export const CALL_LOGS_TOKEN_COLUMNS: TokenColumnNames = {
  ...USAGE_HISTORY_COLUMNS,
  input: "tokens_in",
  output: "tokens_out",
};

type AliasNames = TokenColumnNames;

/** Aliases read by `readLongContextColumns` (the `promptTokens`/`completionTokens` family). */
const CAMEL_ALIASES: AliasNames = {
  input: "lcPromptTokens",
  output: "lcCompletionTokens",
  cacheRead: "lcCacheReadTokens",
  cacheCreation: "lcCacheCreationTokens",
  reasoning: "lcReasoningTokens",
};

/** Per-row / snake_case aliases read by `readLongContextRowColumns`. */
export const LONG_CONTEXT_ROW_ALIASES: TokenColumnNames = {
  input: "lc_input",
  output: "lc_output",
  cacheRead: "lc_cache_read",
  cacheCreation: "lc_cache_creation",
  reasoning: "lc_reasoning",
};

const FIELD_ORDER = ["input", "output", "cacheRead", "cacheCreation", "reasoning"] as const;

const DEFAULT_TIER_KEY = longContextTierKey(LONG_CONTEXT_SQL_THRESHOLDS[0]);

function tierSuffix(tier: LongContextThreshold): string {
  const key = longContextTierKey(tier);
  return key === DEFAULT_TIER_KEY ? "" : `_${key}`;
}

function suffixed(names: AliasNames, tier: LongContextThreshold): AliasNames {
  const suffix = tierSuffix(tier);
  return {
    input: names.input + suffix,
    output: names.output + suffix,
    cacheRead: names.cacheRead + suffix,
    cacheCreation: names.cacheCreation + suffix,
    reasoning: names.reasoning + suffix,
  };
}

function isLongSql(
  promptColumn: string,
  tier: LongContextThreshold,
  onlyWhen: string | undefined
): string {
  const long = `${promptColumn} ${tier.inclusive ? ">=" : ">"} ${tier.threshold}`;
  return onlyWhen ? `(${onlyWhen}) AND ${long}` : long;
}

/**
 * `SUM(CASE WHEN <this request's prompt> > threshold THEN <column> ELSE 0 END)` for each
 * token column and each threshold. `prefix` is the table alias (`"usage_history."`) for
 * joined queries. Rows with NULL prompt tokens count as not long. `onlyWhen` restricts the
 * split to the rows the caller actually prices from tokens (e.g. `provider_cost_usd IS NULL`
 * when rows with a provider-reported cost are billed by that cost instead).
 */
export function longContextSumColumns(
  prefix = "",
  columns: TokenColumnNames = USAGE_HISTORY_COLUMNS,
  aliases: AliasNames = CAMEL_ALIASES,
  onlyWhen?: string
): string {
  return LONG_CONTEXT_SQL_THRESHOLDS.flatMap((tier) => {
    const names = suffixed(aliases, tier);
    const condition = isLongSql(`${prefix}${columns.input}`, tier, onlyWhen);
    return FIELD_ORDER.map(
      (field) =>
        `COALESCE(SUM(CASE WHEN ${condition} THEN ${prefix}${columns[field]} ELSE 0 END), 0) as ${names[field]}`
    );
  }).join(",\n        ");
}

/**
 * Per-ROW variant for unified sources (`SELECT ... FROM usage_history UNION ALL SELECT ...
 * FROM daily_usage_summary`). It exposes each request's long-context share as plain
 * columns so the outer `SUM` can add them up. Summary rows MUST use
 * `LONG_CONTEXT_ZERO_ROW_COLUMNS`: their `tokens_input` is a day's total, and testing it
 * against the per-request threshold would bill the whole history at the long-context rate.
 * `onlyWhen`: see `longContextSumColumns`.
 */
export function longContextRowColumns(
  prefix = "",
  columns: TokenColumnNames = USAGE_HISTORY_COLUMNS,
  onlyWhen?: string
): string {
  return LONG_CONTEXT_SQL_THRESHOLDS.flatMap((tier) => {
    const names = suffixed(LONG_CONTEXT_ROW_ALIASES, tier);
    const condition = isLongSql(`${prefix}${columns.input}`, tier, onlyWhen);
    return FIELD_ORDER.map(
      (field) =>
        `CASE WHEN ${condition} THEN COALESCE(${prefix}${columns[field]}, 0) ELSE 0 END as ${names[field]}`
    );
  }).join(",\n          ");
}

/** The summary-row counterpart of `longContextRowColumns`: aggregated rows are never long. */
export const LONG_CONTEXT_ZERO_ROW_COLUMNS = LONG_CONTEXT_SQL_THRESHOLDS.flatMap((tier) => {
  const names = suffixed(LONG_CONTEXT_ROW_ALIASES, tier);
  return FIELD_ORDER.map((field) => `0 as ${names[field]}`);
}).join(",\n          ");

/**
 * Outer aggregation of the per-row columns above. `aliases: "row"` keeps the snake_case
 * names (for a second aggregation level); the default uses the `lcPromptTokens` family.
 */
export function longContextSumOfRowColumns(aliases: "camel" | "row" = "camel"): string {
  return LONG_CONTEXT_SQL_THRESHOLDS.flatMap((tier) => {
    const source = suffixed(LONG_CONTEXT_ROW_ALIASES, tier);
    const names = suffixed(aliases === "row" ? LONG_CONTEXT_ROW_ALIASES : CAMEL_ALIASES, tier);
    return FIELD_ORDER.map((field) => `COALESCE(SUM(${source[field]}), 0) as ${names[field]}`);
  }).join(",\n        ");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readSplit(row: Record<string, unknown>, names: AliasNames): LongContextSplit {
  return {
    lcInput: num(row[names.input]),
    lcOutput: num(row[names.output]),
    lcCacheRead: num(row[names.cacheRead]),
    lcCacheCreation: num(row[names.cacheCreation]),
    lcReasoning: num(row[names.reasoning]),
  };
}

function readAllTiers(row: Record<string, unknown>, names: AliasNames): LongContextTokens {
  const [defaultTier, ...others] = LONG_CONTEXT_SQL_THRESHOLDS;
  const lcTiers: Record<string, LongContextSplit> = {};
  for (const tier of others)
    lcTiers[longContextTierKey(tier)] = readSplit(row, suffixed(names, tier));
  return { ...readSplit(row, suffixed(names, defaultTier)), lcTiers };
}

/** Read the `lc*` columns selected by `longContextSumColumns` into cost-function tokens. */
export function readLongContextColumns(row: Record<string, unknown>): LongContextTokens {
  return readAllTiers(row, CAMEL_ALIASES);
}

/** Read the snake_case `lc_*` columns produced by `longContextRowColumns` / `...SumOfRowColumns("row")`. */
export function readLongContextRowColumns(row: Record<string, unknown>): LongContextTokens {
  return readAllTiers(row, LONG_CONTEXT_ROW_ALIASES);
}
