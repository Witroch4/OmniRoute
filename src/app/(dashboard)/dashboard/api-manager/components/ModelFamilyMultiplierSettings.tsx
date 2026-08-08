"use client";

import { Input } from "@/shared/components";
import { ProviderField } from "./ModelBudgetRoutingSettings";

export interface FamilyMultiplierDraft {
  enabled: boolean;
  provider: string;
  familyGlob: string;
  /** Kept as a display string (like every other numeric field in this modal —
   * `weeklyLimitUsd`, `minSpendGuaranteeUsd`, ...), already dot-normalized by
   * `normalizeDecimalInput` on every keystroke. Parsed to a number only at
   * save time (`familyMultipliersPayload.ts`). */
  multiplier: string;
}

/** Same "why" as `ModelBudgetRulesLoadStatus` — see that type's doc comment.
 * An empty `rules` array must never be trusted as "cleared" until the GET
 * that was supposed to load it is known to have actually succeeded. */
export type FamilyMultipliersLoadStatus = "loading" | "loaded" | "error";

const FAMILY_PRESETS = [
  "claude-fable-*",
  "claude-opus-*",
  "claude-sonnet-*",
  "claude-haiku-*",
  "gpt-5*",
  "gemini-3*",
];

/**
 * Keep in sync with `MAX_FAMILY_MULTIPLIER` in
 * `src/lib/db/apiKeyModelFamilyMultipliers.ts` — the actual enforced ceiling.
 * Duplicated here only as a UI hint (a client component can't import a
 * `better-sqlite3`-backed server module); the server is what actually rejects
 * an out-of-range save.
 */
const MAX_MULTIPLIER_HINT = 20;

export const EMPTY_FAMILY_MULTIPLIER: FamilyMultiplierDraft = {
  enabled: true,
  provider: "",
  familyGlob: "",
  multiplier: "1.0",
};

/**
 * Accepts both `1.5` and `1,5` as the user types — the owner uses a pt-BR
 * keyboard, where `,` is the natural decimal key — and normalizes to a dot
 * immediately, so what ends up in `rules` (and therefore what gets saved) is
 * always dot-decimal. This is a display-input filter only; it does NOT
 * decide what counts as a valid or neutral multiplier — that's
 * `normalizeFamilyMultiplier`/`resolveFamilyMultiplier` server-side
 * (`src/lib/usage/modelFamilyMultiplier.ts`), which is what actually governs
 * cost computation and must never trust client-side normalization alone.
 */
export function normalizeDecimalInput(raw: string): string {
  return raw.replace(/,/g, ".");
}

export function ModelFamilyMultiplierSettings({
  rules,
  onRulesChange,
  loadStatus,
  onRetryLoad,
  providers,
}: {
  rules: FamilyMultiplierDraft[];
  onRulesChange: (rules: FamilyMultiplierDraft[]) => void;
  loadStatus: FamilyMultipliersLoadStatus;
  onRetryLoad: () => void;
  providers: string[];
}) {
  const update = (index: number, patch: Partial<FamilyMultiplierDraft>) =>
    onRulesChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  // Same rationale as ModelBudgetRoutingSettings.editingDisabled: editing before the
  // GET has actually landed would just get clobbered, and it keeps the save gate
  // (resolveFamilyMultipliersSave) honest about what's really on the server.
  const editingDisabled = loadStatus !== "loaded";

  return (
    <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">Model family spend multiplier</p>
          <p className="text-xs text-text-muted">
            Scales this key&apos;s NORMALIZED (billed) spend for a family against its USD quota —
            never what OmniRoute actually pays the provider. Applies to whichever family the client
            was actually charged for, even on a request a budget-routing rule silently redirected.
            Independent of the routing rules above — a family can carry a multiplier with no
            redirect rule at all. <strong>1.0 is neutral</strong> (no effect, same as having no
            rule); values above 1.0 make that family drain quota faster — e.g. <code>2.0</code>{" "}
            counts every dollar billed as two. Never set this to <code>0</code> — that would make
            matching spend read as free.
          </p>
        </div>
        <button
          type="button"
          disabled={editingDisabled}
          onClick={() => onRulesChange([...rules, { ...EMPTY_FAMILY_MULTIPLIER }])}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/15 px-2.5 py-1.5 text-xs font-semibold text-amber-700 transition-colors dark:text-amber-300 ${
            editingDisabled ? "cursor-not-allowed opacity-50" : ""
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          Add multiplier
        </button>
      </div>

      {loadStatus === "loading" && (
        <p className="mt-3 text-[11px] text-text-muted">
          Loading this key&apos;s existing multipliers…
        </p>
      )}

      {loadStatus === "error" && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
          <span className="material-symbols-outlined text-[16px] text-red-500">error</span>
          <p className="flex-1 text-sm text-red-700 dark:text-red-300">
            Couldn&apos;t load this key&apos;s existing family multipliers. Nothing was changed —
            retry before adding or removing rules here.
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
          No multipliers — every family bills this key at its plain normalized cost (1.0x).
        </p>
      ) : null}

      {loadStatus === "loaded" &&
        rules.map((rule, index) => (
          <div key={index} className="mt-3 rounded-md border border-border p-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <ProviderField
                label="Provider"
                value={rule.provider}
                providers={providers}
                placeholder="provider"
                onChange={(value) => update(index, { provider: value })}
              />
              <div>
                <label className="mb-1 block text-xs text-text-muted">Family</label>
                <Input
                  list="omniroute-family-multiplier-presets"
                  value={rule.familyGlob}
                  onChange={(e) => update(index, { familyGlob: e.target.value })}
                  placeholder="claude-sonnet-*"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-muted">
                  Multiplier (1.0 = neutral)
                </label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={rule.multiplier}
                  onChange={(e) =>
                    update(index, { multiplier: normalizeDecimalInput(e.target.value) })
                  }
                  placeholder="1.0"
                />
              </div>
              <div className="flex items-end justify-between">
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
          </div>
        ))}

      <datalist id="omniroute-family-multiplier-presets">
        {FAMILY_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>

      {loadStatus === "loaded" && (
        <p className="mt-2 text-[11px] text-text-muted">
          A family is a glob over the model id, same convention as model budget routing above. Type{" "}
          <code>1,5</code> or <code>1.5</code> — both work. Values above {MAX_MULTIPLIER_HINT}x are
          rejected on save.
        </p>
      )}
    </div>
  );
}
