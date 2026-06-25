"use client";

import { Input } from "@/shared/components";

export function UsageLimitSettings({
  enabled,
  showUsdInUsageCommand,
  dailyLimitUsd,
  weeklyLimitUsd,
  enabledLabel,
  disabledLabel,
  onEnabledChange,
  onShowUsdInUsageCommandChange,
  onDailyLimitUsdChange,
  onWeeklyLimitUsdChange,
}: {
  enabled: boolean;
  showUsdInUsageCommand: boolean;
  dailyLimitUsd: string;
  weeklyLimitUsd: string;
  enabledLabel: string;
  disabledLabel: string;
  onEnabledChange: (enabled: boolean) => void;
  onShowUsdInUsageCommandChange: (enabled: boolean) => void;
  onDailyLimitUsdChange: (value: string) => void;
  onWeeklyLimitUsdChange: (value: string) => void;
}) {
  return (
    <div className="mt-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">USD usage quota</p>
          <p className="text-xs text-text-muted">
            Blocks this key with a 400 API error after its local USD spend reaches the configured
            daily or weekly quota.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onEnabledChange(!enabled)}
          className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            enabled
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
              : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">paid</span>
          {enabled ? enabledLabel : disabledLabel}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-text-muted mb-1 block">Daily quota (USD)</label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={dailyLimitUsd}
            onChange={(event) => onDailyLimitUsdChange(event.target.value)}
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">Weekly quota (USD)</label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={weeklyLimitUsd}
            onChange={(event) => onWeeklyLimitUsdChange(event.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>
      <div className="mt-3 flex items-start justify-between gap-3 rounded-md border border-border/40 bg-background/40 p-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-main">@@om-usage USD display</p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            When disabled, @@om-usage reports this key quota as percentages.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={showUsdInUsageCommand}
          disabled={!enabled}
          onClick={() => onShowUsdInUsageCommandChange(!showUsdInUsageCommand)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            showUsdInUsageCommand
              ? "border border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "border border-border bg-black/5 text-text-muted dark:bg-white/5"
          } ${!enabled ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <span className="material-symbols-outlined text-[14px]">attach_money</span>
          {showUsdInUsageCommand ? enabledLabel : disabledLabel}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-text-muted">
        Weekly quota follows the cached Claude weekly reset when available; otherwise it falls back
        to a rolling 7 day window. Daily quota uses the Fortaleza calendar day.
      </p>
    </div>
  );
}
