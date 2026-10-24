/**
 * Fork-only settings of the API key access editor.
 *
 * Upstream (#14885) replaced the API Manager's PermissionsModal with this full-page
 * editor. The fork's modal carried settings upstream does not have — the renewal cycle,
 * the minimum-spend guarantee, model budget routing rules and per-family spend
 * multipliers — so they live here, beside the upstream form, instead of inside
 * `useApiKeyAccessForm` (whose PATCH body and initial state are pinned literally by
 * tests/unit/api-key-access-form.test.ts).
 *
 * - Renewal cycle + min-spend guarantee are columns of the key: they ride on the same
 *   PATCH, but only when edited. `PATCH /api/keys/[id]` treats an absent field as
 *   "unchanged", so an untouched editor sends exactly upstream's body.
 * - Budget rules and family multipliers are separate resources
 *   (`/api/keys/[id]/budget-rules`, `/api/keys/[id]/family-multipliers`). They are
 *   loaded once per key and PUT after a successful PATCH — only when edited, and only
 *   when their GET actually succeeded (`resolveModelBudgetRulesSave` /
 *   `resolveFamilyMultipliersSave`: an unloaded `[]` must never be sent as a clear-all).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildInitialRenewalCycleDraft,
  type RenewalCycleDraft,
} from "@/app/(dashboard)/dashboard/api-manager/components/RenewalCycleSettings";
import type {
  ModelBudgetRuleDraft,
  ModelBudgetRulesLoadStatus,
} from "@/app/(dashboard)/dashboard/api-manager/components/ModelBudgetRoutingSettings";
import type { FamilyMultiplierDraft } from "@/app/(dashboard)/dashboard/api-manager/components/ModelFamilyMultiplierSettings";
import { resolveModelBudgetRulesSave } from "@/app/(dashboard)/dashboard/api-manager/modelBudgetRulesPayload";
import { resolveFamilyMultipliersSave } from "@/app/(dashboard)/dashboard/api-manager/familyMultipliersPayload";
import { cycleOwnsExpiry } from "@/shared/utils/apiKeyRenewalCycle";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";
import { parseUsdLimitInput } from "./useApiKeyAccessForm";

/** Fork columns of `GET /api/keys/[id]` that this editor reads. */
export interface ApiKeyForkFields {
  id: string;
  expiresAt?: string | null;
  minSpendGuaranteeEnabled?: boolean | null;
  minSpendGuaranteeUsd?: number | null;
  renewalCycleEnabled?: boolean | null;
  renewalCycleAnchorAt?: string | null;
  renewalCycleMonths?: number | null;
}

export interface ApiKeyForkFieldsState {
  minSpendGuaranteeEnabled: boolean;
  minSpendGuaranteeUsd: string;
  renewalCycle: RenewalCycleDraft;
}

export function createInitialForkFieldsState(
  apiKey: ApiKeyForkFields | null | undefined
): ApiKeyForkFieldsState {
  const guaranteeUsd = apiKey?.minSpendGuaranteeUsd;
  return {
    minSpendGuaranteeEnabled: apiKey?.minSpendGuaranteeEnabled === true,
    minSpendGuaranteeUsd:
      typeof guaranteeUsd === "number" && guaranteeUsd > 0 ? String(guaranteeUsd) : "",
    renewalCycle: buildInitialRenewalCycleDraft({
      renewalCycleEnabled: apiKey?.renewalCycleEnabled === true,
      renewalCycleAnchorAt: apiKey?.renewalCycleAnchorAt ?? null,
      renewalCycleMonths: apiKey?.renewalCycleMonths ?? null,
    }),
  };
}

/**
 * PATCH fields for the edited fork columns only. Each group is sent whole (the same
 * fields the legacy PermissionsModal always sent), so the server sees a consistent
 * cycle/guarantee and an untouched group stays out of the body.
 */
export function buildForkFieldsPatch(
  state: ApiKeyForkFieldsState,
  initial: ApiKeyForkFieldsState
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (
    state.minSpendGuaranteeEnabled !== initial.minSpendGuaranteeEnabled ||
    state.minSpendGuaranteeUsd !== initial.minSpendGuaranteeUsd
  ) {
    patch.minSpendGuaranteeEnabled = state.minSpendGuaranteeEnabled;
    patch.minSpendGuaranteeUsd = parseUsdLimitInput(state.minSpendGuaranteeUsd);
  }
  if (JSON.stringify(state.renewalCycle) !== JSON.stringify(initial.renewalCycle)) {
    patch.renewalCycleEnabled = state.renewalCycle.enabled;
    patch.renewalCycleAnchorAt = state.renewalCycle.anchorAt;
    patch.renewalCycleMonths = state.renewalCycle.months;
    patch.renewRenewalCycle = state.renewalCycle.renewNow;
  }
  return patch;
}

// Same union as ModelBudgetRulesLoadStatus / FamilyMultipliersLoadStatus.
type LoadStatus = ModelBudgetRulesLoadStatus;

interface SideResourceSpec<TDraft, TRow> {
  path: "budget-rules" | "family-multipliers";
  toDraft: (row: TRow) => TDraft;
}

/** Draft + load status + saved baseline for one per-key side resource. */
function useKeySideResource<TDraft, TRow>(apiKeyId: string, spec: SideResourceSpec<TDraft, TRow>) {
  const { path, toDraft } = spec;
  const [drafts, setDrafts] = useState<TDraft[]>([]);
  const [baseline, setBaseline] = useState<TDraft[]>([]);
  // Starts "loading", never an implicit "loaded with []": the save gate depends on it.
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/keys/${encodeURIComponent(apiKeyId)}/${path}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${path} GET failed with status ${res.status}`);
        return res.json() as Promise<{ rules?: TRow[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const loaded = (Array.isArray(data?.rules) ? data.rules : []).map(toDraft);
        setDrafts(loaded);
        setBaseline(loaded);
        setLoadStatus("loaded");
      })
      .catch(() => {
        // Leave the drafts as-is but flag the failure, so the panel shows it instead of
        // "no rules configured" and the save gate refuses to PUT an unloaded [].
        if (!cancelled) setLoadStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiKeyId, path, toDraft, loadNonce]);

  const retryLoad = useCallback(() => {
    setLoadStatus("loading");
    setLoadNonce((n) => n + 1);
  }, []);
  const isDirty = loadStatus === "loaded" && JSON.stringify(drafts) !== JSON.stringify(baseline);
  const reset = useCallback(() => setDrafts(baseline), [baseline]);
  const markClean = useCallback(() => setBaseline(drafts), [drafts]);

  return { drafts, setDrafts, loadStatus, retryLoad, isDirty, reset, markClean };
}

interface BudgetRuleRow {
  enabled: boolean;
  sourceProvider: string;
  sourceFamily: string;
  weeklyLimitUsd: number;
  targetProvider: string;
  targetFamily: string;
}

interface FamilyMultiplierRow {
  enabled: boolean;
  provider: string;
  familyGlob: string;
  multiplier: number;
}

const BUDGET_RULES_SPEC: SideResourceSpec<ModelBudgetRuleDraft, BudgetRuleRow> = {
  path: "budget-rules",
  toDraft: (rule) => ({
    enabled: rule.enabled,
    sourceProvider: rule.sourceProvider,
    sourceFamily: rule.sourceFamily,
    weeklyLimitUsd: String(rule.weeklyLimitUsd),
    targetProvider: rule.targetProvider,
    targetFamily: rule.targetFamily,
  }),
};

const FAMILY_MULTIPLIERS_SPEC: SideResourceSpec<FamilyMultiplierDraft, FamilyMultiplierRow> = {
  path: "family-multipliers",
  toDraft: (rule) => ({
    enabled: rule.enabled,
    provider: rule.provider,
    familyGlob: rule.familyGlob,
    multiplier: String(rule.multiplier),
  }),
};

async function putSideResource(apiKeyId: string, path: string, payload: unknown): Promise<void> {
  const res = await fetch(`/api/keys/${encodeURIComponent(apiKeyId)}/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw new Error(extractApiErrorMessage(data, `HTTP ${res.status}`));
  }
}

function useForkKeyFields(apiKey: ApiKeyForkFields) {
  const [prevKey, setPrevKey] = useState(apiKey);
  const [initial, setInitial] = useState(() => createInitialForkFieldsState(apiKey));
  const [state, setState] = useState(() => createInitialForkFieldsState(apiKey));

  // Same re-sync rule as useApiKeyAccessForm: the post-save refetch replaces the key.
  if (apiKey !== prevKey) {
    setPrevKey(apiKey);
    const fresh = createInitialForkFieldsState(apiKey);
    setInitial(fresh);
    setState(fresh);
  }

  const setMinSpendGuaranteeEnabled = useCallback((minSpendGuaranteeEnabled: boolean) => {
    setState((prev) => ({ ...prev, minSpendGuaranteeEnabled }));
  }, []);
  const setMinSpendGuaranteeUsd = useCallback((minSpendGuaranteeUsd: string) => {
    setState((prev) => ({ ...prev, minSpendGuaranteeUsd }));
  }, []);
  const setRenewalCycle = useCallback((renewalCycle: RenewalCycleDraft) => {
    setState((prev) => ({ ...prev, renewalCycle }));
  }, []);

  return {
    state,
    initial,
    isDirty: JSON.stringify(state) !== JSON.stringify(initial),
    reset: () => setState(initial),
    markClean: () => setInitial(state),
    setMinSpendGuaranteeEnabled,
    setMinSpendGuaranteeUsd,
    setRenewalCycle,
  };
}

export function useApiKeyForkExtras(apiKey: ApiKeyForkFields) {
  const fields = useForkKeyFields(apiKey);
  const budgetRules = useKeySideResource(apiKey.id, BUDGET_RULES_SPEC);
  const familyMultipliers = useKeySideResource(apiKey.id, FAMILY_MULTIPLIERS_SPEC);

  const expiryManagedByCycle = cycleOwnsExpiry({
    renewalCycleEnabled: fields.state.renewalCycle.enabled,
    renewalCycleAnchorAt: fields.state.renewalCycle.anchorAt,
  });

  const isDirty = fields.isDirty || budgetRules.isDirty || familyMultipliers.isDirty;

  const buildPatch = useCallback(
    () => buildForkFieldsPatch(fields.state, fields.initial),
    [fields.state, fields.initial]
  );

  const reset = () => {
    fields.reset();
    budgetRules.reset();
    familyMultipliers.reset();
  };

  /**
   * Runs after the key PATCH succeeded. Returns the error message to surface (the PATCH
   * already committed, so the message says so) or null when everything was saved.
   */
  const saveSideResources = async (): Promise<string | null> => {
    fields.markClean();
    if (budgetRules.isDirty) {
      const decision = resolveModelBudgetRulesSave(budgetRules.loadStatus, budgetRules.drafts);
      if (decision.shouldSave && decision.payload) {
        try {
          await putSideResource(apiKey.id, "budget-rules", decision.payload);
          budgetRules.markClean();
        } catch (err) {
          return `Key permissions were saved, but the model budget routing rules were not: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }
    if (familyMultipliers.isDirty) {
      const decision = resolveFamilyMultipliersSave(
        familyMultipliers.loadStatus,
        familyMultipliers.drafts
      );
      if (decision.shouldSave && decision.payload) {
        try {
          await putSideResource(apiKey.id, "family-multipliers", decision.payload);
          familyMultipliers.markClean();
        } catch (err) {
          return `Key permissions were saved, but the model family multipliers were not: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }
    return null;
  };

  const savedCycle = useMemo(
    () => ({
      enabled: apiKey.renewalCycleEnabled === true,
      anchorAt: apiKey.renewalCycleAnchorAt ?? null,
      months: fields.initial.renewalCycle.months,
    }),
    [apiKey.renewalCycleEnabled, apiKey.renewalCycleAnchorAt, fields.initial.renewalCycle.months]
  );

  return {
    fields,
    budgetRules,
    familyMultipliers,
    expiryManagedByCycle,
    savedCycle,
    isDirty,
    buildPatch,
    reset,
    saveSideResources,
  };
}

export type ApiKeyForkExtras = ReturnType<typeof useApiKeyForkExtras>;
