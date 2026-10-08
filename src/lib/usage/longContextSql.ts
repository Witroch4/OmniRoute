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
 * @module lib/usage/longContextSql
 */

import { LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS, type LongContextTokens } from "./costCalculator";

const T = LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS;

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

/**
 * `SUM(CASE WHEN <this request's prompt> > threshold THEN <column> ELSE 0 END)` for each
 * token column. `prefix` is the table alias (`"usage_history."`) for joined queries.
 * Rows with NULL prompt tokens count as not long.
 */
export function longContextSumColumns(
  prefix = "",
  columns: TokenColumnNames = USAGE_HISTORY_COLUMNS,
  aliases: AliasNames = CAMEL_ALIASES
): string {
  const long = (column: string) =>
    `COALESCE(SUM(CASE WHEN ${prefix}${columns.input} > ${T} THEN ${prefix}${column} ELSE 0 END), 0)`;
  return FIELD_ORDER.map((field) => `${long(columns[field])} as ${aliases[field]}`).join(
    ",\n        "
  );
}

/**
 * Per-ROW variant for unified sources (`SELECT ... FROM usage_history UNION ALL SELECT ...
 * FROM daily_usage_summary`). It exposes each request's long-context share as plain
 * columns so the outer `SUM` can add them up. Summary rows MUST use
 * `LONG_CONTEXT_ZERO_ROW_COLUMNS`: their `tokens_input` is a day's total, and testing it
 * against the per-request threshold would bill the whole history at the long-context rate.
 */
export function longContextRowColumns(
  prefix = "",
  columns: TokenColumnNames = USAGE_HISTORY_COLUMNS
): string {
  const long = (column: string) =>
    `CASE WHEN ${prefix}${columns.input} > ${T} THEN COALESCE(${prefix}${column}, 0) ELSE 0 END`;
  return FIELD_ORDER.map(
    (field) => `${long(columns[field])} as ${LONG_CONTEXT_ROW_ALIASES[field]}`
  ).join(",\n          ");
}

/** The summary-row counterpart of `longContextRowColumns`: aggregated rows are never long. */
export const LONG_CONTEXT_ZERO_ROW_COLUMNS = FIELD_ORDER.map(
  (field) => `0 as ${LONG_CONTEXT_ROW_ALIASES[field]}`
).join(",\n          ");

/**
 * Outer aggregation of the per-row columns above. `aliases: "row"` keeps the snake_case
 * names (for a second aggregation level); the default uses the `lcPromptTokens` family.
 */
export function longContextSumOfRowColumns(aliases: "camel" | "row" = "camel"): string {
  const names = aliases === "row" ? LONG_CONTEXT_ROW_ALIASES : CAMEL_ALIASES;
  return FIELD_ORDER.map(
    (field) => `COALESCE(SUM(${LONG_CONTEXT_ROW_ALIASES[field]}), 0) as ${names[field]}`
  ).join(",\n        ");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read the `lc*` columns selected by `longContextSumColumns` into cost-function tokens. */
export function readLongContextColumns(row: Record<string, unknown>): LongContextTokens {
  return {
    lcInput: num(row.lcPromptTokens),
    lcOutput: num(row.lcCompletionTokens),
    lcCacheRead: num(row.lcCacheReadTokens),
    lcCacheCreation: num(row.lcCacheCreationTokens),
    lcReasoning: num(row.lcReasoningTokens),
  };
}

/** Read the snake_case `lc_*` columns produced by `longContextRowColumns` / `...SumOfRowColumns("row")`. */
export function readLongContextRowColumns(row: Record<string, unknown>): LongContextTokens {
  return {
    lcInput: num(row.lc_input),
    lcOutput: num(row.lc_output),
    lcCacheRead: num(row.lc_cache_read),
    lcCacheCreation: num(row.lc_cache_creation),
    lcReasoning: num(row.lc_reasoning),
  };
}
