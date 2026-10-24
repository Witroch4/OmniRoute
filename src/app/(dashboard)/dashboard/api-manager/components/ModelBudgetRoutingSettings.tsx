"use client";

import { Input } from "@/shared/components";
import Button from "@/shared/components/Button";
import Checkbox from "@/shared/components/Checkbox";
import Icon from "@/shared/components/Icon";
import Select from "@/shared/components/Select";

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

/**
 * Provider is a closed set on this instance (whatever has a connection), so it's a select
 * (the kit `Select` adapter) rather than free text — a mistyped provider used to save
 * silently and just never match anything, with no error anywhere. Two things this still has
 * to get right:
 *
 * 1. Empty `providers` (connections not loaded yet, or the fetch failed) must not render
 *    a `<select>` with zero real options — that would trap the admin into being unable to
 *    fill the rule at all. Falls back to the original free-text `<Input>` in that case.
 * 2. A rule already on file can name a provider that no longer has a connection (removed
 *    since the rule was saved). That value must still show up as the selected option —
 *    never silently coerced to blank/first-item — or the admin could save the rule with a
 *    provider they never chose. Handled by injecting the stored value as its own option
 *    when it isn't in the live `providers` list.
 */
/** Exported for reuse by `ModelFamilyMultiplierSettings.tsx` — same closed-set-of-connected-
 * providers rationale applies there. */
export function ProviderField({
  label,
  value,
  providers,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  providers: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  if (providers.length === 0) {
    return (
      <Input
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    );
  }

  const isKnownOrEmpty = value === "" || providers.includes(value);

  const options = [
    { value: "", label: "Select provider…" },
    ...(isKnownOrEmpty ? [] : [{ value, label: `${value} (no longer connected)` }]),
    ...providers.map((provider) => ({ value: provider, label: provider })),
  ];

  return (
    <Select
      label={label}
      value={value}
      options={options}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ModelBudgetRoutingSettings({
  rules,
  onRulesChange,
  loadStatus,
  onRetryLoad,
  providers,
}: {
  rules: ModelBudgetRuleDraft[];
  onRulesChange: (rules: ModelBudgetRuleDraft[]) => void;
  loadStatus: ModelBudgetRulesLoadStatus;
  onRetryLoad: () => void;
  providers: string[];
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
    <div className="mt-1 rounded-lg border border-info/20 bg-info/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">Model budget routing</p>
          <p className="text-xs text-text-muted">
            Caps one model family&apos;s weekly spend for this key. Once the cap is reached,
            matching requests are served by the target family instead, and the key keeps being
            charged at the original family&apos;s rates.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon="add"
          className="shrink-0"
          disabled={editingDisabled}
          onClick={() => onRulesChange([...rules, { ...EMPTY_BUDGET_RULE }])}
        >
          Add rule
        </Button>
      </div>

      {loadStatus === "loading" && (
        <p className="mt-3 text-[11px] text-text-muted">Loading this key&apos;s existing rules…</p>
      )}

      {loadStatus === "error" && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
          <Icon name="error" size={16} className="text-error" />
          <p className="flex-1 text-sm text-error">
            Couldn&apos;t load this key&apos;s existing budget rules. Nothing was changed — retry
            before adding or removing rules here.
          </p>
          <Button variant="ghost" size="sm" className="shrink-0 text-error" onClick={onRetryLoad}>
            Retry
          </Button>
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
              <ProviderField
                label="From provider"
                value={rule.sourceProvider}
                providers={providers}
                placeholder="from provider"
                onChange={(value) => update(index, { sourceProvider: value })}
              />
              <Input
                label="From family"
                list="omniroute-family-presets"
                value={rule.sourceFamily}
                onChange={(e) => update(index, { sourceFamily: e.target.value })}
                placeholder="claude-opus-*"
              />
              <Input
                label="Weekly limit (USD)"
                type="number"
                min={0}
                step="0.01"
                value={rule.weeklyLimitUsd}
                onChange={(e) => update(index, { weeklyLimitUsd: e.target.value })}
                placeholder="USD / week"
              />
              <ProviderField
                label="To provider"
                value={rule.targetProvider}
                providers={providers}
                placeholder="to provider"
                onChange={(value) => update(index, { targetProvider: value })}
              />
              <Input
                label="To family"
                list="omniroute-family-presets"
                value={rule.targetFamily}
                onChange={(e) => update(index, { targetFamily: e.target.value })}
                placeholder="claude-sonnet-*"
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <Checkbox
                label="Enabled"
                checked={rule.enabled}
                onChange={(e) => update(index, { enabled: e.target.checked })}
              />
              <Button
                variant="ghost"
                size="sm"
                className="text-error"
                onClick={() => onRulesChange(rules.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
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
