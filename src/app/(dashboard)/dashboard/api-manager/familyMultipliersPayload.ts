import type {
  FamilyMultiplierDraft,
  FamilyMultipliersLoadStatus,
} from "./components/ModelFamilyMultiplierSettings";

/** PUT body shape for `/api/keys/:id/family-multipliers` (see
 * `normalizeFamilyMultipliersPayload`). */
export interface FamilyMultiplierPutInput {
  enabled: boolean;
  provider: string;
  familyGlob: string;
  multiplier: number;
}

/**
 * Shapes the permissions-modal draft rows into the PUT payload for
 * `/api/keys/:id/family-multipliers`. Mirrors
 * `buildModelBudgetRulesSavePayload`: incomplete rows (missing provider/family,
 * or a non-positive multiplier) are dropped silently, and `multiplier` is
 * coerced to a number only here, at save time — the draft keeps it as a
 * string like every other numeric field in this modal.
 *
 * The draft's `multiplier` is already dot-normalized on every keystroke by
 * `normalizeDecimalInput` in the settings component, but this still runs the
 * same comma-to-dot substitution defensively (e.g. a value pasted in rather
 * than typed) before parsing.
 */
export function buildFamilyMultipliersSavePayload(drafts: FamilyMultiplierDraft[]): {
  rules: FamilyMultiplierPutInput[];
} {
  const rules: FamilyMultiplierPutInput[] = [];

  for (const rule of drafts) {
    const provider = rule.provider.trim();
    const familyGlob = rule.familyGlob.trim();
    const multiplier = Number(rule.multiplier.trim().replace(",", "."));

    if (!provider || !familyGlob || !Number.isFinite(multiplier) || multiplier <= 0) {
      continue;
    }

    rules.push({
      enabled: rule.enabled,
      provider,
      familyGlob,
      multiplier,
    });
  }

  return { rules };
}

export interface FamilyMultipliersSaveDecision {
  shouldSave: boolean;
  payload: { rules: FamilyMultiplierPutInput[] } | null;
}

/**
 * Same "load must actually succeed before a save can touch this resource"
 * gate as `resolveModelBudgetRulesSave` — see that function's doc comment for
 * the full incident this protects against (a transient GET failure silently
 * wiping a key's real rules via an empty-array PUT that looked legitimate).
 */
export function resolveFamilyMultipliersSave(
  loadStatus: FamilyMultipliersLoadStatus,
  drafts: FamilyMultiplierDraft[]
): FamilyMultipliersSaveDecision {
  if (loadStatus !== "loaded") {
    return { shouldSave: false, payload: null };
  }
  return { shouldSave: true, payload: buildFamilyMultipliersSavePayload(drafts) };
}
