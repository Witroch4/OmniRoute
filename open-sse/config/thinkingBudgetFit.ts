/**
 * Keep Gemini's thinking budget INSIDE the output cap, with room for the answer.
 *
 * Gemini's `maxOutputTokens` includes the thoughts, and Cloud Code rejects a
 * `thinkingBudget` that is not below it. The old fix raised the cap to
 * `thinkingBudget + 1` — which leaves ONE token for the visible answer when the
 * model thinks to its budget. Measured with Claude Code on agy: `max_tokens 32000`
 * + effort high became `thinkingBudget 32768` / `maxOutputTokens 32769`. (The
 * 2026-09-10 note in the omniroute-ops skill shows the same failure on `-low`:
 * ~28.9k of 30k tokens spent thinking, the JSON cut mid-string.)
 *
 * Rule, matching Anthropic's semantics (thinking lives inside max_tokens):
 * - the answer always keeps a reserve: 25% of the cap, clamped to [1024, 8192];
 * - when the cap leaves less than that after the budget, the BUDGET shrinks — the
 *   client's cap is respected;
 * - with no cap, the cap becomes budget + 8192 (and the caller's model ceiling,
 *   when given, still wins).
 *
 * Scope: Gemini model ids only (`reconcileThinkingBudget`). Claude served through
 * Antigravity has its thinkingConfig stripped later and relied on the old bump as
 * headroom for the backend's own tier thinking, so it — like gpt-oss and any caller
 * that does not pass a model — keeps the legacy `budget + 1` behaviour.
 *
 * Leaf module: no imports.
 */

export const THINKING_ANSWER_RESERVE_MIN = 1024;
export const THINKING_ANSWER_RESERVE_MAX = 8192;

type GenerationConfigLike = Record<string, unknown> & {
  maxOutputTokens?: unknown;
  thinkingConfig?: unknown;
};

export function answerReserveFor(cap: number): number {
  return Math.min(
    THINKING_ANSWER_RESERVE_MAX,
    Math.max(THINKING_ANSWER_RESERVE_MIN, Math.floor(cap / 4))
  );
}

/** Mutates `config` in place; no-op unless a positive numeric thinkingBudget is set. */
export function fitThinkingBudgetIntoOutput(
  config: GenerationConfigLike,
  modelCeiling?: number | null
): void {
  const thinking =
    config.thinkingConfig && typeof config.thinkingConfig === "object"
      ? (config.thinkingConfig as Record<string, unknown>)
      : null;
  const budget = Number(thinking?.thinkingBudget);
  if (!thinking || !Number.isFinite(budget) || budget <= 0) return;

  let cap = Number(config.maxOutputTokens);
  if (!Number.isFinite(cap) || cap <= 0) cap = Math.floor(budget) + THINKING_ANSWER_RESERVE_MAX;
  if (typeof modelCeiling === "number" && Number.isFinite(modelCeiling) && modelCeiling > 0) {
    cap = Math.min(cap, modelCeiling);
  }
  cap = Math.floor(cap);

  const reserve = answerReserveFor(cap);
  let fitted = Math.floor(budget);
  if (cap - fitted < reserve) {
    fitted = cap > reserve ? cap - reserve : Math.floor(cap / 2);
  }

  config.maxOutputTokens = cap;
  thinking.thinkingBudget = Math.max(0, fitted);
}

/** Legacy behaviour: raise the cap to budget + 1 when it does not exceed the budget. */
export function applyLegacyThinkingBump(config: GenerationConfigLike): void {
  const thinking =
    config.thinkingConfig && typeof config.thinkingConfig === "object"
      ? (config.thinkingConfig as Record<string, unknown>)
      : null;
  const budget = Number(thinking?.thinkingBudget);
  const cap = Number(config.maxOutputTokens);
  if (Number.isFinite(budget) && budget > 0 && (!Number.isFinite(cap) || cap <= budget)) {
    config.maxOutputTokens = Math.floor(budget) + 1;
  }
}

/** True when the fitted rule applies: a Gemini model id (the measured case). */
export function usesFittedThinkingBudget(model: string | null | undefined): boolean {
  return typeof model === "string" && /gemini/i.test(model);
}

/**
 * Which thinking knob a Gemini request carries — exactly ONE per request.
 *
 * Upstream #13463 sends Gemini 3.8 the string `thinkingLevel` instead of a numeric
 * `thinkingBudget` (and stops injecting `includeThoughts`), to keep thoughts from
 * eating the output cap. The fork solves that same problem with the numeric budget:
 * the `-low/-medium/-high` suffix sets the default budget (openai-to-gemini.ts
 * `tierSuffixThinkingBudget`) and, on Antigravity, `reconcileThinkingBudget` keeps it
 * inside `max_tokens` with an answer reserve — both measured on the wire against
 * agy/gemini-3.8-flash-*. So Gemini 3.8 keeps the numeric budget, and only Gemini 4
 * (#16603: `gemini-4-*` takes `thinkingLevel`, never a budget) uses the level.
 * An explicit client/operator `thinkingLevel` still wins on every model (the
 * translators then drop the budget).
 */
export function geminiUsesThinkingLevel(model: string | null | undefined): boolean {
  return typeof model === "string" && /(?:^|\/)gemini-4(?:$|[-.])/i.test(model);
}

export function reconcileThinkingBudget(
  config: GenerationConfigLike,
  model: string | null | undefined,
  modelCeiling?: number | null
): void {
  if (usesFittedThinkingBudget(model)) fitThinkingBudgetIntoOutput(config, modelCeiling);
  else applyLegacyThinkingBump(config);
}
