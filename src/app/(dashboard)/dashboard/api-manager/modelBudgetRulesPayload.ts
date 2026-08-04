import type {
  ModelBudgetRuleDraft,
  ModelBudgetRulesLoadStatus,
} from "./components/ModelBudgetRoutingSettings";

/** PUT body shape for `/api/keys/:id/budget-rules` (see `normalizeBudgetRulesPayload`). */
export interface ModelBudgetRulePutInput {
  enabled: boolean;
  sourceProvider: string;
  sourceFamily: string;
  weeklyLimitUsd: number;
  targetProvider: string;
  targetFamily: string;
}

/**
 * Shapes the permissions-modal draft rows into the PUT payload for
 * `/api/keys/:id/budget-rules`. Incomplete rows (missing provider/family, or a
 * non-positive weekly limit) are dropped silently — same contract as an empty
 * min-spend guarantee field today. `weeklyLimitUsd` is coerced to a number
 * only here, at save time; the draft keeps it as a string like every other
 * USD field in this modal (`dailyUsageLimitUsd`, `minSpendGuaranteeUsd`, ...).
 *
 * String fields are trimmed before the completeness check, so a
 * whitespace-only value (e.g. `sourceFamily: " "`) is treated the same as an
 * empty one and the row is dropped rather than sent as a rule with a blank
 * family glob — mirrors the server's own `requireText()` in the route handler.
 */
export function buildModelBudgetRulesSavePayload(drafts: ModelBudgetRuleDraft[]): {
  rules: ModelBudgetRulePutInput[];
} {
  const rules: ModelBudgetRulePutInput[] = [];

  for (const rule of drafts) {
    const sourceProvider = rule.sourceProvider.trim();
    const sourceFamily = rule.sourceFamily.trim();
    const targetProvider = rule.targetProvider.trim();
    const targetFamily = rule.targetFamily.trim();
    const weeklyLimitUsd = Number(rule.weeklyLimitUsd);

    if (
      !sourceProvider ||
      !sourceFamily ||
      !targetProvider ||
      !targetFamily ||
      !Number.isFinite(weeklyLimitUsd) ||
      weeklyLimitUsd <= 0
    ) {
      continue;
    }

    rules.push({
      enabled: rule.enabled,
      sourceProvider,
      sourceFamily,
      weeklyLimitUsd,
      targetProvider,
      targetFamily,
    });
  }

  return { rules };
}

export interface ModelBudgetRulesSaveDecision {
  shouldSave: boolean;
  payload: { rules: ModelBudgetRulePutInput[] } | null;
}

/**
 * Fix round 1 (Task 10 review, Finding 1 — Critical): a `PUT { rules: [] }` is the
 * API's legitimate "clear all rules" call (Task 9 contract), but `budgetRules` in the
 * modal is `[]` both when the admin genuinely has no rules *and* when the GET that was
 * supposed to load them hasn't succeeded yet — still in flight, or failed outright. Those
 * two situations are indistinguishable by looking at the array alone, which is exactly
 * how a transient GET failure (or a Save clicked before the GET resolves) turned into a
 * silent, unrecoverable wipe of a key's real budget rules.
 *
 * This is the single gate every save path must go through: it only authorizes sending
 * the PUT when `loadStatus === "loaded"`, i.e. the GET is known to have actually
 * completed successfully. Anything else (`"loading"` or `"error"`) means "we don't know
 * what this key's rules really are" — the correct move is to leave them untouched on the
 * server, not to overwrite them with whatever the (unloaded) local state happens to be.
 * This also closes the save-before-load race: clicking Save while the GET is still in
 * flight has `loadStatus === "loading"`, so `shouldSave` is false regardless of timing.
 */
export function resolveModelBudgetRulesSave(
  loadStatus: ModelBudgetRulesLoadStatus,
  drafts: ModelBudgetRuleDraft[]
): ModelBudgetRulesSaveDecision {
  if (loadStatus !== "loaded") {
    return { shouldSave: false, payload: null };
  }
  return { shouldSave: true, payload: buildModelBudgetRulesSavePayload(drafts) };
}
