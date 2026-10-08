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

/**
 * `SUM(CASE WHEN <this request's prompt> > threshold THEN <column> ELSE 0 END)` for each
 * token column. `prefix` is the table alias (`"usage_history."`) for joined queries.
 * Rows with NULL `tokens_input` count as not long.
 */
export function longContextSumColumns(prefix = ""): string {
  const long = (column: string) =>
    `COALESCE(SUM(CASE WHEN ${prefix}tokens_input > ${T} THEN ${prefix}${column} ELSE 0 END), 0)`;
  return [
    `${long("tokens_input")} as lcPromptTokens`,
    `${long("tokens_output")} as lcCompletionTokens`,
    `${long("tokens_cache_read")} as lcCacheReadTokens`,
    `${long("tokens_cache_creation")} as lcCacheCreationTokens`,
    `${long("tokens_reasoning")} as lcReasoningTokens`,
  ].join(",\n        ");
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
