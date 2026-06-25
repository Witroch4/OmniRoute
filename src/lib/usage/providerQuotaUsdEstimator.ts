import { getDbInstance } from "@/lib/db/core";
import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { getProviderQuotaWindowStartIso } from "@/lib/db/quotaResetEvents";
import { calculateCost } from "./costCalculator";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

type JsonRecord = Record<string, unknown>;
type WindowStartSource = "reset_event" | "snapshot" | "inferred" | "unavailable";
type EstimateConfidence = "high" | "medium" | "low" | "unavailable";

export interface ProviderQuotaEstimateConnection {
  id: string;
  provider: string;
}

export interface ProviderQuotaUsdWindowEstimate {
  connectionId: string;
  provider: string;
  windowName: string;
  resetAtIso: string | null;
  windowStartIso: string | null;
  windowStartSource: WindowStartSource;
  remainingPercentage: number | null;
  usedPercentage: number | null;
  observedSpendUsd: number;
  observedRequests: number;
  estimatedFullWindowUsd: number | null;
  estimatedUsdPerPercent: number | null;
  confidence: EstimateConfidence;
  unavailableReason: string | null;
}

export interface ProviderQuotaUsdEstimate {
  connectionId: string;
  provider: string;
  generatedAtIso: string;
  costSource: "usage_history_pricing";
  primaryWindowName: string | null;
  windows: ProviderQuotaUsdWindowEstimate[];
}

interface QuotaSnapshotObservationRow {
  remainingPercentage: number | null;
  nextResetAt: string | null;
  createdAt: string | null;
}

interface UsageCostRow {
  model: string | null;
  serviceTier: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
  requests: number | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function resetDay(value: string | null): string | null {
  const iso = parseIso(value);
  return iso ? iso.slice(0, 10) : null;
}

function normalizeQuotaName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isWeeklyWindow(windowName: string): boolean {
  const normalized = normalizeQuotaName(windowName);
  return (
    (normalized.includes("weekly") || normalized.includes("7d")) && !normalized.includes("sonnet")
  );
}

function inferWindowDurationMs(windowName: string): number | null {
  const normalized = normalizeQuotaName(windowName);
  const dayMatch = normalized.match(/(?:^|\s)(\d+)\s*d(?:\s|$)/);
  if (dayMatch) return Math.max(1, Number(dayMatch[1])) * DAY_MS;

  const hourMatch = normalized.match(/(?:^|\s)(\d+)\s*h(?:\s|$)/);
  if (hourMatch) return Math.max(1, Number(hourMatch[1])) * HOUR_MS;

  if (normalized.includes("weekly")) return WEEK_MS;
  if (
    normalized.includes("session") ||
    normalized.includes("five hour") ||
    normalized === "window 5h"
  ) {
    return 5 * HOUR_MS;
  }
  if (normalized.includes("daily") || normalized.includes("today")) return DAY_MS;
  if (normalized.includes("monthly") || normalized.includes("month")) return 30 * DAY_MS;

  return null;
}

function quotaEntries(cache: ProviderLimitsCacheEntry | null): Array<[string, JsonRecord]> {
  const quotas = asRecord(cache?.quotas);
  if (!quotas) return [];

  const entries: Array<[string, JsonRecord]> = [];
  for (const [name, value] of Object.entries(quotas)) {
    const quota = asRecord(value);
    if (quota) entries.push([name, quota]);
  }
  return entries;
}

function getRemainingPercentage(windowName: string, quota: JsonRecord): number | null {
  const explicit = toFiniteNumberOrNull(quota.remainingPercentage);
  if (explicit !== null) return clampPercent(explicit);

  const total = toFiniteNumberOrNull(quota.total);
  const used = toFiniteNumberOrNull(quota.used);
  if (total !== null && total > 0 && used !== null) {
    return clampPercent(((total - used) / total) * 100);
  }

  const remaining = toFiniteNumberOrNull(quota.remaining);
  if (total !== null && total > 0 && remaining !== null) {
    return clampPercent((remaining / total) * 100);
  }

  const normalized = normalizeQuotaName(windowName);
  if (normalized.includes("weekly") || normalized.includes("session")) {
    return null;
  }
  return null;
}

function isWeeklyQuotaResetSnapshot(row: QuotaSnapshotObservationRow, targetResetAtIso: string) {
  const targetDay = resetDay(targetResetAtIso);
  return !!targetDay && resetDay(row.nextResetAt) === targetDay;
}

function getObservedWeeklyWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs: number
): string | null {
  try {
    const rows = getDbInstance()
      .prepare(
        `
        SELECT
          remaining_percentage as remainingPercentage,
          next_reset_at as nextResetAt,
          created_at as createdAt
        FROM quota_snapshots
        WHERE connection_id = @connectionId
          AND LOWER(window_key) LIKE '%weekly%'
          AND LOWER(window_key) NOT LIKE '%sonnet%'
          AND created_at <= @nowIso
        ORDER BY created_at ASC, id ASC
      `
      )
      .all({
        connectionId,
        nowIso: new Date(nowMs).toISOString(),
      }) as QuotaSnapshotObservationRow[];

    let observedStartIso: string | null = null;
    let previousUsedPercent: number | null = null;

    for (const row of rows) {
      if (!row.createdAt || !isWeeklyQuotaResetSnapshot(row, targetResetAtIso)) continue;
      const usedPercent = clampPercent(100 - toNumber(row.remainingPercentage));

      if (!observedStartIso) {
        observedStartIso = parseIso(row.createdAt);
      } else if (previousUsedPercent !== null) {
        const droppedToResetFloor = usedPercent <= 1 && previousUsedPercent > usedPercent;
        const significantDrop = previousUsedPercent - usedPercent >= 5;
        if (droppedToResetFloor || significantDrop) {
          observedStartIso = parseIso(row.createdAt);
        }
      }

      previousUsedPercent = usedPercent;
    }

    return observedStartIso;
  } catch {
    return null;
  }
}

function resolveWindowStart(
  connectionId: string,
  windowName: string,
  resetAtIso: string | null,
  nowMs: number
): { windowStartIso: string | null; windowStartSource: WindowStartSource } {
  if (!resetAtIso) {
    return { windowStartIso: null, windowStartSource: "unavailable" };
  }

  if (isWeeklyWindow(windowName)) {
    const resetEventStart = getProviderQuotaWindowStartIso(connectionId, resetAtIso, nowMs);
    if (resetEventStart) {
      return { windowStartIso: resetEventStart, windowStartSource: "reset_event" };
    }

    const snapshotStart = getObservedWeeklyWindowStartIso(connectionId, resetAtIso, nowMs);
    if (snapshotStart) {
      return { windowStartIso: snapshotStart, windowStartSource: "snapshot" };
    }
  }

  const durationMs = inferWindowDurationMs(windowName);
  const resetMs = Date.parse(resetAtIso);
  if (durationMs && Number.isFinite(resetMs)) {
    return {
      windowStartIso: new Date(resetMs - durationMs).toISOString(),
      windowStartSource: "inferred",
    };
  }

  return { windowStartIso: null, windowStartSource: "unavailable" };
}

async function getConnectionSpendUsdSince(
  provider: string,
  connectionId: string,
  sinceIso: string
): Promise<{ costUsd: number; requests: number }> {
  const rows = getDbInstance()
    .prepare(
      `
      SELECT
        model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as inputTokens,
        COALESCE(SUM(tokens_output), 0) as outputTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COUNT(*) as requests
      FROM usage_history
      WHERE connection_id = @connectionId
        AND LOWER(provider) = LOWER(@provider)
        AND timestamp >= @sinceIso
        AND success = 1
      GROUP BY model, serviceTier
    `
    )
    .all({ provider, connectionId, sinceIso }) as UsageCostRow[];

  let costUsd = 0;
  let requests = 0;

  for (const row of rows) {
    const model = typeof row.model === "string" ? row.model : "";
    if (!model) continue;

    requests += Math.max(0, toNumber(row.requests));
    costUsd += await calculateCost(
      provider,
      model,
      {
        input: toNumber(row.inputTokens),
        output: toNumber(row.outputTokens),
        cacheRead: toNumber(row.cacheReadTokens),
        cacheCreation: toNumber(row.cacheCreationTokens),
        reasoning: toNumber(row.reasoningTokens),
      },
      {
        provider,
        model,
        serviceTier: typeof row.serviceTier === "string" ? row.serviceTier : "standard",
      }
    );
  }

  return { costUsd: roundUsd(Math.max(0, costUsd)), requests };
}

function confidenceFor(
  usedPercentage: number,
  requests: number,
  windowStartSource: WindowStartSource
): EstimateConfidence {
  if (usedPercentage < 1 || requests === 0) return "unavailable";
  if (usedPercentage < 2 || requests < 2) return "low";
  if (usedPercentage < 10 || windowStartSource === "inferred") return "medium";
  return "high";
}

function unavailableReasonFor(args: {
  resetAtIso: string | null;
  windowStartIso: string | null;
  usedPercentage: number | null;
  observedSpendUsd: number;
  observedRequests: number;
}): string | null {
  if (!args.resetAtIso) return "This quota does not expose a reset time.";
  if (!args.windowStartIso) return "OmniRoute cannot infer this quota window start yet.";
  if (args.usedPercentage === null || args.usedPercentage <= 0) {
    return "This quota has not moved enough to estimate USD capacity.";
  }
  if (args.observedRequests <= 0)
    return "No OmniRoute requests were recorded in this quota window.";
  if (args.observedSpendUsd <= 0) {
    return "Requests exist, but no priced USD usage was available for this provider/model.";
  }
  return null;
}

export function estimateUsdForPercent(
  window: Pick<ProviderQuotaUsdWindowEstimate, "estimatedUsdPerPercent">,
  percent: number
): number | null {
  const perPercent = window.estimatedUsdPerPercent;
  if (perPercent === null || !Number.isFinite(perPercent)) return null;
  return roundUsd(perPercent * clampPercent(percent));
}

export async function buildProviderQuotaUsdEstimate(
  connection: ProviderQuotaEstimateConnection,
  cache: ProviderLimitsCacheEntry | null,
  deps: { now?: () => number } = {}
): Promise<ProviderQuotaUsdEstimate> {
  const nowMs = deps.now?.() ?? Date.now();
  const windows: ProviderQuotaUsdWindowEstimate[] = [];

  for (const [windowName, quota] of quotaEntries(cache)) {
    const resetAtIso = parseIso(quota.resetAt);
    const remainingPercentage = getRemainingPercentage(windowName, quota);
    const usedPercentage =
      remainingPercentage === null ? null : clampPercent(100 - remainingPercentage);
    const { windowStartIso, windowStartSource } = resolveWindowStart(
      connection.id,
      windowName,
      resetAtIso,
      nowMs
    );

    const spend =
      windowStartIso && usedPercentage !== null
        ? await getConnectionSpendUsdSince(connection.provider, connection.id, windowStartIso)
        : { costUsd: 0, requests: 0 };
    const unavailableReason = unavailableReasonFor({
      resetAtIso,
      windowStartIso,
      usedPercentage,
      observedSpendUsd: spend.costUsd,
      observedRequests: spend.requests,
    });
    const estimatedFullWindowUsd =
      !unavailableReason && usedPercentage && usedPercentage > 0
        ? roundUsd(spend.costUsd / (usedPercentage / 100))
        : null;
    const estimatedUsdPerPercent =
      estimatedFullWindowUsd !== null ? roundUsd(estimatedFullWindowUsd / 100) : null;

    windows.push({
      connectionId: connection.id,
      provider: connection.provider,
      windowName,
      resetAtIso,
      windowStartIso,
      windowStartSource,
      remainingPercentage,
      usedPercentage,
      observedSpendUsd: spend.costUsd,
      observedRequests: spend.requests,
      estimatedFullWindowUsd,
      estimatedUsdPerPercent,
      confidence:
        unavailableReason || usedPercentage === null
          ? "unavailable"
          : confidenceFor(usedPercentage, spend.requests, windowStartSource),
      unavailableReason,
    });
  }

  const primary =
    windows.find((window) => isWeeklyWindow(window.windowName) && window.estimatedFullWindowUsd) ??
    windows.find((window) => window.estimatedFullWindowUsd) ??
    windows[0] ??
    null;

  return {
    connectionId: connection.id,
    provider: connection.provider,
    generatedAtIso: new Date(nowMs).toISOString(),
    costSource: "usage_history_pricing",
    primaryWindowName: primary?.windowName ?? null,
    windows,
  };
}
