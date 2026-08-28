/**
 * Recurring renewal cycle for API keys — the date math, with no I/O.
 *
 * A cycle is (anchor timestamp, period in months). The anchor's day-of-month is what
 * recurs: anchor 2026-08-27 with months = 1 produces 27 Sep, 27 Oct, 27 Nov, ... The
 * cutoff this resolves to is materialized into the key's existing `expires_at` column,
 * so enforcement reuses the expiry gates that already exist (see migration 129).
 *
 * All arithmetic is done in UTC. Timestamps are stored as UTC ISO strings and the
 * dashboard writes them from a local `datetime-local` input, so a fixed-offset zone
 * (America/Sao_Paulo has had no DST since 2019) sees the local day-of-month recur
 * exactly as picked. A DST-observing zone can see the local clock time of the cutoff
 * shift by an hour across a transition; the DAY it lands on is unaffected except for a
 * cutoff picked within an hour of local midnight.
 */

export const MIN_RENEWAL_CYCLE_MONTHS = 1;
export const MAX_RENEWAL_CYCLE_MONTHS = 60;
export const DEFAULT_RENEWAL_CYCLE_MONTHS = 1;

const MS_PER_DAY = 86_400_000;

/**
 * Hard stop for the occurrence walk below. The estimate lands within one step of the
 * answer, so this is only a guard against a pathological input (e.g. an anchor far in
 * the past combined with a corrupted period), never a limit on real cycles.
 */
const MAX_OCCURRENCE_STEPS = 24;

export function normalizeRenewalCycleMonths(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return DEFAULT_RENEWAL_CYCLE_MONTHS;
  const floored = Math.floor(parsed);
  if (floored < MIN_RENEWAL_CYCLE_MONTHS) return MIN_RENEWAL_CYCLE_MONTHS;
  if (floored > MAX_RENEWAL_CYCLE_MONTHS) return MAX_RENEWAL_CYCLE_MONTHS;
  return floored;
}

/** Parse an ISO timestamp, returning null for anything unusable. */
export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Add whole months to the anchor while KEEPING the anchor's day-of-month.
 *
 * The clamp is the reason this is not `setUTCMonth(m + n)`: that overflows 31 Jan into
 * 3 Mar. Clamping to the target month's last day gives 28 Feb, and because the clamp is
 * recomputed from the ORIGINAL anchor day on every step (never from the clamped result),
 * the following month returns to 31 Mar instead of sticking at the 28th.
 */
export function addMonthsKeepingAnchorDay(anchorMs: number, monthsToAdd: number): number {
  const anchor = new Date(anchorMs);
  const anchorDay = anchor.getUTCDate();

  const targetYear = anchor.getUTCFullYear();
  const targetMonth = anchor.getUTCMonth() + monthsToAdd;

  // Day 0 of month N+1 is the last day of month N.
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(anchorDay, daysInTargetMonth),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds()
  );
}

/**
 * The first cycle occurrence strictly after `fromMs`.
 *
 * "Strictly after" is what makes renewing on the cutoff day itself land on the NEXT
 * month rather than resolving to the moment that just passed. It also means a client
 * who pays three days late loses those three days but keeps renewing on the same
 * day-of-month, which is the point of anchoring the cycle instead of adding 30 days.
 *
 * Returns null when the anchor is unusable, so callers can leave `expires_at` alone
 * rather than writing a garbage cutoff that would lock the key out.
 */
export function computeNextRenewalCutoff(
  anchorAt: unknown,
  months: unknown,
  fromMs: number
): string | null {
  const anchorMs = parseTimestampMs(anchorAt);
  if (anchorMs === null || !Number.isFinite(fromMs)) return null;

  const step = normalizeRenewalCycleMonths(months);

  // An anchor set in the future is itself the next cutoff — the first period runs from
  // now until that date.
  if (anchorMs > fromMs) return new Date(anchorMs).toISOString();

  const anchor = new Date(anchorMs);
  const from = new Date(fromMs);
  const monthsElapsed =
    (from.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (from.getUTCMonth() - anchor.getUTCMonth());

  // Estimate the step count, then correct in whichever direction the day-of-month and
  // time-of-day comparison demands. Both loops are bounded.
  let steps = Math.max(0, Math.floor(monthsElapsed / step));

  let guard = 0;
  while (addMonthsKeepingAnchorDay(anchorMs, steps * step) <= fromMs) {
    steps += 1;
    if ((guard += 1) > MAX_OCCURRENCE_STEPS) break;
  }

  guard = 0;
  while (steps > 0 && addMonthsKeepingAnchorDay(anchorMs, (steps - 1) * step) > fromMs) {
    steps -= 1;
    if ((guard += 1) > MAX_OCCURRENCE_STEPS) break;
  }

  return new Date(addMonthsKeepingAnchorDay(anchorMs, steps * step)).toISOString();
}

/**
 * Whole days between now and a cutoff. Positive = still valid (rounded UP, so any
 * remaining fraction of a day reads as at least "1 day left" rather than "0"). Negative
 * = already past (rounded DOWN, so "-1" means it lapsed within the last day).
 * Returns null when there is no usable cutoff.
 */
export function daysUntilCutoff(cutoffAt: unknown, nowMs: number): number | null {
  const cutoffMs = parseTimestampMs(cutoffAt);
  if (cutoffMs === null || !Number.isFinite(nowMs)) return null;
  const diff = cutoffMs - nowMs;
  return diff >= 0 ? Math.ceil(diff / MS_PER_DAY) : Math.floor(diff / MS_PER_DAY);
}

export interface RenewalCycleConfig {
  renewalCycleEnabled?: boolean;
  renewalCycleAnchorAt?: string | null;
  renewalCycleMonths?: number | null;
}

/**
 * Whether the cycle currently governs `expires_at`. While true the manual expiry field
 * is not the operator's to set — the cycle recomputes it (migration 129).
 */
export function cycleOwnsExpiry(config: RenewalCycleConfig): boolean {
  return (
    config.renewalCycleEnabled === true && parseTimestampMs(config.renewalCycleAnchorAt) !== null
  );
}

/**
 * What an incoming update should do to `expires_at`.
 *
 * `expires_at` is the single enforcement point (migration 129), so exactly one of these
 * outcomes has to be chosen on every save — leaving it implicit is how a plain rename
 * ends up silently granting a client another paid month.
 */
export type RenewalExpiryDecision =
  /** Cycle governs the expiry and it moved: write this cutoff. */
  | { action: "set"; expiresAt: string }
  /** Cycle no longer governs the expiry: release the cutoff it had written. */
  | { action: "clear" }
  /** Cycle governs the expiry and nothing moved: ignore any client-sent expiresAt. */
  | { action: "freeze" }
  /** No cycle involved: the client's expiresAt applies as it always did. */
  | { action: "passthrough" };

export interface RenewalCycleState extends RenewalCycleConfig {
  expiresAt?: string | null;
}

export interface RenewalCycleUpdate extends RenewalCycleConfig {
  /** Explicit operator intent: advance to the next occurrence after now. */
  renewRenewalCycle?: boolean;
}

/**
 * Decide what happens to `expires_at` for one save.
 *
 * The cutoff only ever moves on an EXPLICIT intent — the operator changed the cycle's
 * configuration, or pressed renew — never as a side effect of an unrelated edit. That
 * is what keeps a lapsed key lapsed while its owner renames it, and it makes the whole
 * thing idempotent: re-saving the same form twice cannot buy a second period.
 *
 * Lives here rather than next to the SQL so the dashboard can preview the exact cutoff
 * the server is about to write, instead of reimplementing the rule and drifting from it.
 */
export function resolveRenewalCycleExpiry(
  current: RenewalCycleState,
  update: RenewalCycleUpdate,
  nowMs: number
): RenewalExpiryDecision {
  const next = {
    renewalCycleEnabled:
      update.renewalCycleEnabled !== undefined
        ? update.renewalCycleEnabled
        : current.renewalCycleEnabled === true,
    renewalCycleAnchorAt:
      update.renewalCycleAnchorAt !== undefined
        ? update.renewalCycleAnchorAt
        : (current.renewalCycleAnchorAt ?? null),
    renewalCycleMonths: normalizeRenewalCycleMonths(
      update.renewalCycleMonths !== undefined
        ? update.renewalCycleMonths
        : current.renewalCycleMonths
    ),
  };

  const wasOwned = cycleOwnsExpiry(current);

  if (!cycleOwnsExpiry(next)) {
    // Releasing an owned expiry clears it. Without this, switching the cycle off leaves
    // behind the cutoff the cycle wrote, and the key would still die on a date the
    // operator never picked — with no UI left on screen explaining why.
    return wasOwned ? { action: "clear" } : { action: "passthrough" };
  }

  const anchorChanged =
    parseTimestampMs(next.renewalCycleAnchorAt) !== parseTimestampMs(current.renewalCycleAnchorAt);
  const monthsChanged =
    next.renewalCycleMonths !== normalizeRenewalCycleMonths(current.renewalCycleMonths);
  const turnedOn = !wasOwned;
  const hasNoCutoff = parseTimestampMs(current.expiresAt) === null;

  if (
    update.renewRenewalCycle === true ||
    turnedOn ||
    anchorChanged ||
    monthsChanged ||
    hasNoCutoff
  ) {
    const expiresAt = computeNextRenewalCutoff(
      next.renewalCycleAnchorAt,
      next.renewalCycleMonths,
      nowMs
    );
    return expiresAt ? { action: "set", expiresAt } : { action: "freeze" };
  }

  return { action: "freeze" };
}
