"use client";

import { Input } from "@/shared/components";

export function MinSpendGuaranteeSettings({
  enabled,
  guaranteeUsd,
  onEnabledChange,
  onGuaranteeUsdChange,
}: {
  enabled: boolean;
  guaranteeUsd: string;
  onEnabledChange: (enabled: boolean) => void;
  onGuaranteeUsdChange: (value: string) => void;
}) {
  return (
    <div className="mt-1 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">Minimum spend guarantee</p>
          <p className="text-xs text-text-muted">
            Guarantees this key can spend at least the configured amount per week, routing past the
            provider quota cutoff if needed. Once the weekly spend reaches the floor, the normal
            cutoff applies again.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onEnabledChange(!enabled)}
          className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            enabled
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
              : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">savings</span>
          {enabled ? "On" : "Off"}
        </button>
      </div>
      <div className="mt-3">
        <label className="text-xs text-text-muted mb-1 block">Minimum spend / week (USD)</label>
        <Input
          type="number"
          min={0}
          step="0.01"
          value={guaranteeUsd}
          onChange={(event) => onGuaranteeUsdChange(event.target.value)}
          placeholder="0.00"
        />
      </div>
      <p className="mt-2 text-[11px] text-text-muted">
        Overrides the provider quota cutoff (like the bypass permission, but only until the weekly
        floor is met, and without needing that permission). A hard USD usage quota above still takes
        precedence. Rolling 7 day window, global across providers.
      </p>
    </div>
  );
}
