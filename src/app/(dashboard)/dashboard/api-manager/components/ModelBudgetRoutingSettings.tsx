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
}: {
  rules: ModelBudgetRuleDraft[];
  onRulesChange: (rules: ModelBudgetRuleDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<ModelBudgetRuleDraft>) =>
    onRulesChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

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
          onClick={() => onRulesChange([...rules, { ...EMPTY_BUDGET_RULE }])}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/15 px-2.5 py-1.5 text-xs font-semibold text-sky-700 transition-colors dark:text-sky-300"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          Add rule
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="mt-3 text-[11px] text-text-muted">
          No rules — this key is uncapped per family.
        </p>
      ) : null}

      {rules.map((rule, index) => (
        <div key={index} className="mt-3 rounded-md border border-border p-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            <Input
              value={rule.sourceProvider}
              onChange={(e) => update(index, { sourceProvider: e.target.value })}
              placeholder="from provider"
            />
            <Input
              list="omniroute-family-presets"
              value={rule.sourceFamily}
              onChange={(e) => update(index, { sourceFamily: e.target.value })}
              placeholder="claude-opus-*"
            />
            <Input
              type="number"
              min={0}
              step="0.01"
              value={rule.weeklyLimitUsd}
              onChange={(e) => update(index, { weeklyLimitUsd: e.target.value })}
              placeholder="USD / week"
            />
            <Input
              value={rule.targetProvider}
              onChange={(e) => update(index, { targetProvider: e.target.value })}
              placeholder="to provider"
            />
            <Input
              list="omniroute-family-presets"
              value={rule.targetFamily}
              onChange={(e) => update(index, { targetFamily: e.target.value })}
              placeholder="claude-sonnet-*"
            />
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

      <p className="mt-2 text-[11px] text-text-muted">
        A family is a glob over the model id, so <code>claude-opus-*</code> also covers models
        released later. The target resolves to the newest matching model on that provider; a target
        that matches nothing leaves the rule inactive. Weekly window follows the provider reset, the
        same one the USD usage quota uses.
      </p>
    </div>
  );
}
