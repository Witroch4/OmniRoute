"use client";

import { useMemo } from "react";
import { Input } from "@/shared/components";
import {
  DEFAULT_RENEWAL_CYCLE_MONTHS,
  MAX_RENEWAL_CYCLE_MONTHS,
  MIN_RENEWAL_CYCLE_MONTHS,
  daysUntilCutoff,
  normalizeRenewalCycleMonths,
  resolveRenewalCycleExpiry,
} from "@/shared/utils/apiKeyRenewalCycle";
import { useMinuteClock } from "@/shared/hooks/useMinuteClock";
import { toLocalDateTimeInputValue } from "../apiManagerPageUtils";

export interface RenewalCycleDraft {
  enabled: boolean;
  anchorAt: string | null;
  months: number;
  /** Set by the renew button; cleared once the form is saved. */
  renewNow: boolean;
}

export function buildInitialRenewalCycleDraft(apiKey?: {
  renewalCycleEnabled?: boolean;
  renewalCycleAnchorAt?: string | null;
  renewalCycleMonths?: number | null;
}): RenewalCycleDraft {
  return {
    enabled: apiKey?.renewalCycleEnabled === true,
    anchorAt: apiKey?.renewalCycleAnchorAt ?? null,
    months: normalizeRenewalCycleMonths(apiKey?.renewalCycleMonths),
    renewNow: false,
  };
}

function formatCutoff(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RenewalCycleSettings({
  draft,
  onDraftChange,
  currentExpiresAt,
  savedCycle,
  locale,
  labels,
}: {
  draft: RenewalCycleDraft;
  onDraftChange: (draft: RenewalCycleDraft) => void;
  /** The cutoff currently stored on the key. */
  currentExpiresAt: string | null;
  /** The cycle as last saved — what the server compares the draft against. */
  savedCycle: { enabled: boolean; anchorAt: string | null; months: number };
  locale: string;
  labels: {
    title: string;
    description: string;
    on: string;
    off: string;
    baseDate: string;
    baseDateHint: string;
    everyMonths: string;
    disablesOn: string;
    daysLeft: (days: number) => string;
    lapsed: (days: number) => string;
    noBaseDate: string;
    renewNow: string;
    renewQueued: (date: string) => string;
    ownsExpiry: string;
  };
}) {
  // Subscribed rather than read inline: Date.now() in a render body is impure. The
  // minute tick also keeps the countdown honest while the modal stays open — a key can
  // lapse under the operator's eyes.
  const nowMs = useMinuteClock();

  // Previewed through the SAME resolver the server runs on save, so what the card
  // promises and what the PATCH writes cannot drift apart.
  const preview = useMemo(() => {
    const decision = resolveRenewalCycleExpiry(
      {
        renewalCycleEnabled: savedCycle.enabled,
        renewalCycleAnchorAt: savedCycle.anchorAt,
        renewalCycleMonths: savedCycle.months,
        expiresAt: currentExpiresAt,
      },
      {
        renewalCycleEnabled: draft.enabled,
        renewalCycleAnchorAt: draft.anchorAt,
        renewalCycleMonths: draft.months,
        renewRenewalCycle: draft.renewNow,
      },
      nowMs
    );

    if (decision.action === "set") return { cutoff: decision.expiresAt, moves: true };
    if (decision.action === "freeze") return { cutoff: currentExpiresAt, moves: false };
    return { cutoff: null, moves: false };
  }, [draft, savedCycle, currentExpiresAt, nowMs]);

  const daysLeft = preview.cutoff ? daysUntilCutoff(preview.cutoff, nowMs) : null;

  return (
    <div className="flex flex-col gap-3 p-3 rounded-lg border border-violet-500/25 bg-violet-500/5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-main">{labels.title}</p>
          <p className="text-xs text-text-muted">{labels.description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          onClick={() => onDraftChange({ ...draft, enabled: !draft.enabled })}
          className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
            draft.enabled
              ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30"
              : "bg-black/5 dark:bg-white/5 text-text-muted border border-border"
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">event_repeat</span>
          {draft.enabled ? labels.on : labels.off}
        </button>
      </div>

      {draft.enabled && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label className="text-xs text-text-muted mb-1 block">{labels.baseDate}</label>
              <input
                type="datetime-local"
                value={toLocalDateTimeInputValue(draft.anchorAt)}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) {
                    onDraftChange({ ...draft, anchorAt: null });
                    return;
                  }
                  const date = new Date(value);
                  if (!Number.isNaN(date.getTime())) {
                    onDraftChange({ ...draft, anchorAt: date.toISOString() });
                  }
                }}
                className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background text-text-main"
              />
            </div>
            <div className="w-full sm:w-32">
              <label className="text-xs text-text-muted mb-1 block">{labels.everyMonths}</label>
              <Input
                type="number"
                min={MIN_RENEWAL_CYCLE_MONTHS}
                max={MAX_RENEWAL_CYCLE_MONTHS}
                step={1}
                value={String(draft.months)}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    months: normalizeRenewalCycleMonths(
                      event.target.value === "" ? DEFAULT_RENEWAL_CYCLE_MONTHS : event.target.value
                    ),
                  })
                }
              />
            </div>
          </div>
          <p className="text-[11px] text-text-muted">{labels.baseDateHint}</p>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background/60 px-2.5 py-2">
            {preview.cutoff ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-text-main">
                  {labels.disablesOn} <strong>{formatCutoff(preview.cutoff, locale)}</strong>
                </span>
                <span
                  className={`text-[11px] font-medium ${
                    daysLeft !== null && daysLeft > 7
                      ? "text-emerald-600 dark:text-emerald-400"
                      : daysLeft !== null && daysLeft >= 0
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {daysLeft === null
                    ? ""
                    : daysLeft >= 0
                      ? labels.daysLeft(daysLeft)
                      : labels.lapsed(Math.abs(daysLeft))}
                </span>
              </div>
            ) : (
              <span className="text-xs text-text-muted">{labels.noBaseDate}</span>
            )}

            <button
              type="button"
              disabled={!draft.anchorAt || draft.renewNow}
              onClick={() => onDraftChange({ ...draft, renewNow: true })}
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[14px]">autorenew</span>
              {labels.renewNow}
            </button>
          </div>

          {draft.renewNow && preview.cutoff && (
            <p className="text-[11px] font-medium text-violet-700 dark:text-violet-300">
              {labels.renewQueued(formatCutoff(preview.cutoff, locale))}
            </p>
          )}
          <p className="text-[11px] text-text-muted">{labels.ownsExpiry}</p>
        </>
      )}
    </div>
  );
}
