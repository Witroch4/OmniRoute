"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { translateUsageOrFallback, type UsageTranslationValues } from "./i18nFallback";
import { formatCountdown, formatQuotaLabel } from "./utils";

type EstimateWindow = {
  windowName: string;
  resetAtIso: string | null;
  windowStartIso: string | null;
  windowStartSource: string;
  remainingPercentage: number | null;
  usedPercentage: number | null;
  observedSpendUsd: number;
  observedRequests: number;
  estimatedFullWindowUsd: number | null;
  estimatedUsdPerPercent: number | null;
  confidence: "high" | "medium" | "low" | "unavailable";
  unavailableReason: string | null;
};

type EstimatePayload = {
  provider: string;
  generatedAtIso: string;
  costSource: string;
  primaryWindowName: string | null;
  windows: EstimateWindow[];
} | null;

interface Props {
  isOpen: boolean;
  estimate: EstimatePayload;
  providerLabel: string;
  accountName: string;
  onClose: () => void;
}

const CONFIDENCE_CLASS: Record<EstimateWindow["confidence"], string> = {
  high: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  medium: "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-300",
  low: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  unavailable: "border-border bg-bg-subtle text-text-muted",
};

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}%`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function confidenceLabel(
  value: EstimateWindow["confidence"],
  tr: (key: string, fallback: string, values?: UsageTranslationValues) => string
): string {
  if (value === "high") return tr("quotaUsdConfidenceHigh", "High");
  if (value === "medium") return tr("quotaUsdConfidenceMedium", "Medium");
  if (value === "low") return tr("quotaUsdConfidenceLow", "Low");
  return tr("quotaUsdConfidenceUnavailable", "Unavailable");
}

export default function QuotaUsdEstimateModal({
  isOpen,
  estimate,
  providerLabel,
  accountName,
  onClose,
}: Props) {
  const t = useTranslations("usage");
  const tr = (key: string, fallback: string, values?: UsageTranslationValues) =>
    translateUsageOrFallback(t, key, fallback, values);
  const [targetPercent, setTargetPercent] = useState(25);
  const windows = useMemo(() => estimate?.windows ?? [], [estimate]);
  const initialWindowName = estimate?.primaryWindowName ?? windows[0]?.windowName ?? "";
  const [selectedWindowName, setSelectedWindowName] = useState(initialWindowName);

  const selectedWindow = useMemo(() => {
    return windows.find((window) => window.windowName === selectedWindowName) ?? windows[0] ?? null;
  }, [selectedWindowName, windows]);

  if (!isOpen) return null;

  const simulatedUsd =
    selectedWindow?.estimatedUsdPerPercent != null
      ? selectedWindow.estimatedUsdPerPercent * targetPercent
      : null;
  const resetCountdown = selectedWindow?.resetAtIso
    ? formatCountdown(selectedWindow.resetAtIso)
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={tr("quotaUsdEstimate", "USD estimate")}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg-subtle">
              <ProviderIcon providerId={estimate?.provider || ""} size={26} type="color" />
            </div>
            <div className="min-w-0">
              <h3 className="m-0 truncate text-sm font-semibold text-text-main">
                {tr("quotaUsdEstimate", "USD estimate")}
              </h3>
              <p className="m-0 truncate text-xs text-text-muted">
                {providerLabel} - {accountName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-black/[0.04] hover:text-text-main dark:hover:bg-white/[0.04]"
            aria-label={tr("close", "Close")}
            title={tr("close", "Close")}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          {windows.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {windows.map((window) => {
                const active = window.windowName === selectedWindow?.windowName;
                return (
                  <button
                    key={window.windowName}
                    type="button"
                    onClick={() => setSelectedWindowName(window.windowName)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors ${
                      active
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-bg-subtle text-text-muted hover:text-text-main"
                    }`}
                  >
                    {formatQuotaLabel(window.windowName)}
                  </button>
                );
              })}
            </div>
          )}

          {!selectedWindow ? (
            <div className="rounded-md border border-border bg-bg-subtle px-3 py-4 text-sm text-text-muted">
              {tr("quotaUsdNoEstimate", "No USD estimate available for this account.")}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-md border border-border bg-bg-subtle px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-text-muted">
                    {tr("quotaUsdUsed", "Used")}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums text-text-main">
                    {formatPercent(selectedWindow.usedPercentage)}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-bg-subtle px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-text-muted">
                    {tr("quotaUsdObservedSpend", "Spend")}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums text-text-main">
                    {formatUsd(selectedWindow.observedSpendUsd)}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-bg-subtle px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-text-muted">
                    {tr("quotaUsdFullEstimate", "100% est.")}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums text-text-main">
                    {formatUsd(selectedWindow.estimatedFullWindowUsd)}
                  </div>
                </div>
                <div className="rounded-md border border-border bg-bg-subtle px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase text-text-muted">
                    {tr("quotaUsdRequests", "Requests")}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums text-text-main">
                    {selectedWindow.observedRequests.toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-border bg-surface px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor="quota-usd-percent"
                    className="text-xs font-semibold text-text-main"
                  >
                    {tr("quotaUsdPercentSlider", "Quota percent")}
                  </label>
                  <span className="text-sm font-bold tabular-nums text-text-main">
                    {targetPercent}%
                  </span>
                </div>
                <input
                  id="quota-usd-percent"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={targetPercent}
                  onChange={(event) => setTargetPercent(Number(event.target.value))}
                  className="mt-3 h-2 w-full cursor-pointer accent-primary"
                />
                <div className="mt-3 flex items-baseline justify-between gap-3">
                  <span className="text-xs text-text-muted">
                    {tr("quotaUsdSelectedValue", "Estimated USD")}
                  </span>
                  <span className="text-2xl font-bold tabular-nums text-text-main">
                    {formatUsd(simulatedUsd)}
                  </span>
                </div>
              </div>

              <div className="grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                <div>
                  <span className="font-semibold text-text-main">
                    {tr("quotaUsdWindowStart", "Window start")}
                  </span>{" "}
                  {formatDateTime(selectedWindow.windowStartIso)}
                </div>
                <div>
                  <span className="font-semibold text-text-main">
                    {tr("quotaUsdReset", "Reset")}
                  </span>{" "}
                  {resetCountdown || formatDateTime(selectedWindow.resetAtIso)}
                </div>
                <div>
                  <span className="font-semibold text-text-main">
                    {tr("quotaUsdSource", "Source")}
                  </span>{" "}
                  {selectedWindow.windowStartSource}
                </div>
                <div>
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CONFIDENCE_CLASS[selectedWindow.confidence]}`}
                  >
                    {confidenceLabel(selectedWindow.confidence, tr)}
                  </span>
                </div>
              </div>

              {selectedWindow.unavailableReason && (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  {selectedWindow.unavailableReason}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
