import type { ModelBudgetRuleDraft } from "./components/ModelBudgetRoutingSettings";

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
 */
export function buildModelBudgetRulesSavePayload(drafts: ModelBudgetRuleDraft[]): {
  rules: ModelBudgetRulePutInput[];
} {
  const rules = drafts
    .filter(
      (rule) =>
        rule.sourceProvider &&
        rule.sourceFamily &&
        rule.targetProvider &&
        rule.targetFamily &&
        Number(rule.weeklyLimitUsd) > 0
    )
    .map((rule) => ({
      enabled: rule.enabled,
      sourceProvider: rule.sourceProvider,
      sourceFamily: rule.sourceFamily,
      weeklyLimitUsd: Number(rule.weeklyLimitUsd),
      targetProvider: rule.targetProvider,
      targetFamily: rule.targetFamily,
    }));
  return { rules };
}
