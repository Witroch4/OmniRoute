"use client";

import { Input } from "@/shared/components";

export interface ModelBudgetRuleDraft {
  enabled: boolean;
  sourceProvider: string;
  sourceFamily: string;
  weeklyLimitUsd: string;
  targetProvider: string;
  targetFamily: string;
}

/**
 * Distinct from "the rule list is empty" — this is *why* `rules` currently
 * holds what it holds. "loading"/"error" both mean the GET hasn't produced a
 * trustworthy list yet, so an empty array in either of those states must
 * never be read as "the admin cleared their rules" (see
 * `resolveModelBudgetRulesSave` in `modelBudgetRulesPayload.ts`, which is the
 * thing that actually enforces that — this type only carries the state).
 */
export type ModelBudgetRulesLoadStatus = "loading" | "loaded" | "error";

const FAMILY_PRESETS = [
  "claude-fable-*",
  "claude-opus-*",
  "claude-sonnet-*",
  "claude-haiku-*",
  "gpt-5*",
  "gemini-3*",
];

export const EMPTY_BUDGET_RULE: ModelBudgetRuleDraft = {
  enabled: true,
  sourceProvider: "",
  sourceFamily: "",
  weeklyLimitUsd: "",
  targetProvider: "",
  targetFamily: "",
};

export function ModelBudgetRoutingSettings({
  rules,
  onRulesChange,
  loadStatus,
  onRetryLoad,
}: {
  rules: ModelBudgetRuleDraft[];
  onRulesChange: (rules: ModelBudgetRuleDraft[]) => void;
  loadStatus: ModelBudgetRulesLoadStatus;
  onRetryLoad: () => void;
}) {
  const update = (index: number, patch: Partial<ModelBudgetRuleDraft>) =>
    onRulesChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  // Adding/removing rows is only safe once the existing list has actually loaded —
  // otherwise a rule added while still loading would just get clobbered by the GET
  // response landing right after, and (more importantly) it keeps the panel's visible
  // state in sync with what will really be sent on save (loadStatus !== "loaded" =>
  // this panel is left untouched at save time, so there is nothing useful to edit yet).
  const editingDisabled = loadStatus !== "loaded";

  return (
    <div className="mt-1 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">Model budget routing</p>
          <p className="text-xs text-text-muted">
            Caps one model family&apos;s weekly spend for this key. Once the cap is reached,
            matching requests are served by the target family instead, and the key keeps being
            charged at the original family&apos;s rates.
          </p>
        </div>
        <button
          type="button"
          disabled={editingDisabled}
          onClick={() => onRulesChange([...rules, { ...EMPTY_BUDGET_RULE }])}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/15 px-2.5 py-1.5 text-xs font-semibold text-sky-700 transition-colors dark:text-sky-300 ${
            editingDisabled ? "cursor-not-allowed opacity-50" : ""
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          Add rule
        </button>
      </div>

      {loadStatus === "loading" && (
        <p className="mt-3 text-[11px] text-text-muted">Loading this key&apos;s existing rules…</p>
      )}

      {loadStatus === "error" && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
          <span className="material-symbols-outlined text-[16px] text-red-500">error</span>
          <p className="flex-1 text-sm text-red-700 dark:text-red-300">
            Couldn&apos;t load this key&apos;s existing budget rules. Nothing was changed — retry
            before adding or removing rules here.
          </p>
          <button
            type="button"
            onClick={onRetryLoad}
            className="shrink-0 text-xs font-semibold text-red-700 underline dark:text-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {loadStatus === "loaded" && rules.length === 0 ? (
        <p className="mt-3 text-[11px] text-text-muted">
          No rules — this key is uncapped per family.
        </p>
      ) : null}

      {loadStatus === "loaded" &&
        rules.map((rule, index) => (
          <div key={index} className="mt-3 rounded-md border border-border p-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
              <div>
                <label className="mb-1 block text-xs text-text-muted">From provider</label>
                <Input
                  value={rule.sourceProvider}
                  onChange={(e) => update(index, { sourceProvider: e.target.value })}
                  placeholder="from provider"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-muted">From family</label>
                <Input
                  list="omniroute-family-presets"
                  value={rule.sourceFamily}
                  onChange={(e) => update(index, { sourceFamily: e.target.value })}
                  placeholder="claude-opus-*"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-muted">Weekly limit (USD)</label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={rule.weeklyLimitUsd}
                  onChange={(e) => update(index, { weeklyLimitUsd: e.target.value })}
                  placeholder="USD / week"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-muted">To provider</label>
                <Input
                  value={rule.targetProvider}
                  onChange={(e) => update(index, { targetProvider: e.target.value })}
                  placeholder="to provider"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-muted">To family</label>
                <Input
                  list="omniroute-family-presets"
                  value={rule.targetFamily}
                  onChange={(e) => update(index, { targetFamily: e.target.value })}
                  placeholder="claude-sonnet-*"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <label className="flex items-center gap-2 text-[11px] text-text-muted">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => update(index, { enabled: e.target.checked })}
                />
                Enabled
              </label>
              <button
                type="button"
                onClick={() => onRulesChange(rules.filter((_, i) => i !== index))}
                className="text-[11px] text-red-500"
              >
                Remove
              </button>
            </div>
          </div>
        ))}

      <datalist id="omniroute-family-presets">
        {FAMILY_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>

      {loadStatus === "loaded" && (
        <p className="mt-2 text-[11px] text-text-muted">
          A family is a glob over the model id, so <code>claude-opus-*</code> also covers models
          released later. The target resolves to the newest matching model on that provider; a
          target that matches nothing leaves the rule inactive. Weekly window follows the provider
          reset, the same one the USD usage quota uses.
        </p>
      )}
    </div>
  );
}
