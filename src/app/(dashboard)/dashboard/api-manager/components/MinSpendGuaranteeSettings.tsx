"use client";

import { Input } from "@/shared/components";
import Toggle from "@/shared/components/Toggle";

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
    <div className="mt-1 rounded-lg border border-warning/20 bg-warning/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">Minimum spend guarantee</p>
          <p className="text-xs text-text-muted">
            Guarantees this key can spend at least the configured amount per week, routing past the
            provider quota cutoff if needed. Once the weekly spend reaches the floor, the normal
            cutoff applies again.
          </p>
        </div>
        <Toggle
          size="sm"
          className="shrink-0"
          checked={enabled}
          onChange={onEnabledChange}
          ariaLabel="Minimum spend guarantee"
        />
      </div>
      <div className="mt-3">
        <Input
          label="Minimum spend / week (USD)"
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
