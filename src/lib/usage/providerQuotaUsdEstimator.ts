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
  costSource: "recorded_cost_history_or_usage_history_pricing";
  primaryWindowName: string | null;
  windows: ProviderQuotaUsdWindowEstimate[];
}

interface QuotaSnapshotObservationRow {
  remainingPercentage: number | null;
  nextResetAt: string | null;
  createdAt: string | null;
}

interface UsageCostRow {
  id: number;
  timestamp: string | null;
  apiKeyId: string | null;
  connectionId: string | null;
  model: string | null;
  serviceTier: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
}

interface RecordedCostRow {
  rowId: number;
  apiKeyId: string;
  timestamp: number;
  cost: number;
}

interface ProviderConnectionIdRow {
  id: string;
}

interface CurrentConnectionUsageBoundaryRow {
  firstTimestamp: string | null;
}

interface HistoricalConnectionRow {
  connectionId: string;
  lastTimestamp: string | null;
}

const RECORDED_COST_MATCH_TOLERANCE_MS = 30_000;

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

    const durationMs = inferWindowDurationMs(windowName);
    const resetMs = Date.parse(resetAtIso);
    if (durationMs && Number.isFinite(resetMs)) {
      return {
        windowStartIso: new Date(resetMs - durationMs).toISOString(),
        windowStartSource: "inferred",
      };
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

function uniqueApiKeyIds(rows: UsageCostRow[]): string[] {
  return Array.from(
    new Set(
      rows
        .map((row) => (typeof row.apiKeyId === "string" ? row.apiKeyId : ""))
        .filter((value) => value.length > 0)
    )
  );
}

function appendNamedPlaceholders(
  params: Record<string, unknown>,
  prefix: string,
  values: string[]
): string {
  return values
    .map((value, index) => {
      const key = `${prefix}${index}`;
      params[key] = value;
      return `@${key}`;
    })
    .join(", ");
}

function getActiveProviderConnectionIds(provider: string): string[] {
  try {
    const rows = getDbInstance()
      .prepare(
        `
        SELECT id
        FROM provider_connections
        WHERE LOWER(provider) = LOWER(@provider)
          AND COALESCE(is_active, 1) = 1
        ORDER BY id ASC
      `
      )
      .all({ provider }) as ProviderConnectionIdRow[];
    return rows.map((row) => row.id).filter((id) => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function getCurrentConnectionUsageBoundary(
  provider: string,
  connectionId: string,
  sinceIso: string,
  nowIso: string
): CurrentConnectionUsageBoundaryRow | null {
  try {
    return (
      (getDbInstance()
        .prepare(
          `
          SELECT MIN(timestamp) as firstTimestamp
          FROM usage_history
          WHERE connection_id = @connectionId
            AND LOWER(provider) = LOWER(@provider)
            AND timestamp >= @sinceIso
            AND timestamp <= @nowIso
            AND success = 1
        `
        )
        .get({ provider, connectionId, sinceIso, nowIso }) as CurrentConnectionUsageBoundaryRow) ??
      null
    );
  } catch {
    return null;
  }
}

function getConnectionApiKeyIdsSince(
  provider: string,
  connectionId: string,
  sinceIso: string,
  nowIso: string
): string[] {
  try {
    const rows = getDbInstance()
      .prepare(
        `
        SELECT DISTINCT api_key_id as apiKeyId
        FROM usage_history
        WHERE connection_id = @connectionId
          AND LOWER(provider) = LOWER(@provider)
          AND timestamp >= @sinceIso
          AND timestamp <= @nowIso
          AND success = 1
          AND api_key_id IS NOT NULL
      `
      )
      .all({ provider, connectionId, sinceIso, nowIso }) as Array<{ apiKeyId: string | null }>;
    return rows
      .map((row) => (typeof row.apiKeyId === "string" ? row.apiKeyId : ""))
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function resolveSpendConnectionIds(
  provider: string,
  connectionId: string,
  sinceIso: string,
  nowMs: number
): string[] {
  const activeConnectionIds = getActiveProviderConnectionIds(provider);
  if (activeConnectionIds.length !== 1 || activeConnectionIds[0] !== connectionId) {
    return [connectionId];
  }

  const nowIso = new Date(nowMs).toISOString();
  const boundary = getCurrentConnectionUsageBoundary(provider, connectionId, sinceIso, nowIso);
  const firstTimestamp = parseIso(boundary?.firstTimestamp);
  if (!firstTimestamp) return [connectionId];

  const apiKeyIds = getConnectionApiKeyIdsSince(provider, connectionId, sinceIso, nowIso);
  if (apiKeyIds.length === 0) return [connectionId];

  try {
    const params: Record<string, unknown> = {
      provider,
      connectionId,
      sinceIso,
      firstTimestamp,
    };
    const apiKeyPlaceholders = appendNamedPlaceholders(params, "apiKey", apiKeyIds);
    const rows = getDbInstance()
      .prepare(
        `
        SELECT
          connection_id as connectionId,
          MAX(timestamp) as lastTimestamp
        FROM usage_history
        WHERE LOWER(provider) = LOWER(@provider)
          AND connection_id IS NOT NULL
          AND connection_id != @connectionId
          AND timestamp >= @sinceIso
          AND timestamp < @firstTimestamp
          AND success = 1
          AND api_key_id IN (${apiKeyPlaceholders})
        GROUP BY connection_id
        ORDER BY lastTimestamp ASC
      `
      )
      .all(params) as HistoricalConnectionRow[];

    const historicalIds = rows
      .filter((row) => parseIso(row.lastTimestamp))
      .map((row) => row.connectionId)
      .filter((id) => typeof id === "string" && id.length > 0);
    return [...historicalIds, connectionId];
  } catch {
    return [connectionId];
  }
}

function getRecordedCostsByApiKey(
  apiKeyIds: string[],
  sinceMs: number,
  nowMs: number
): Map<string, RecordedCostRow[]> {
  if (apiKeyIds.length === 0) return new Map();

  try {
    const placeholders = apiKeyIds.map((_, index) => `@apiKey${index}`).join(", ");
    const params: Record<string, unknown> = {
      sinceMs: Math.max(0, sinceMs - RECORDED_COST_MATCH_TOLERANCE_MS),
      untilMs: nowMs + RECORDED_COST_MATCH_TOLERANCE_MS,
    };
    apiKeyIds.forEach((apiKeyId, index) => {
      params[`apiKey${index}`] = apiKeyId;
    });

    const rows = getDbInstance()
      .prepare(
        `
        SELECT
          id as rowId,
          api_key_id as apiKeyId,
          timestamp,
          cost
        FROM domain_cost_history
        WHERE api_key_id IN (${placeholders})
          AND timestamp >= @sinceMs
          AND timestamp <= @untilMs
        ORDER BY api_key_id ASC, timestamp ASC, rowid ASC
      `
      )
      .all(params) as RecordedCostRow[];

    const byApiKey = new Map<string, RecordedCostRow[]>();
    for (const row of rows) {
      if (!row.apiKeyId || !Number.isFinite(row.timestamp) || !Number.isFinite(row.cost)) {
        continue;
      }
      const list = byApiKey.get(row.apiKeyId) ?? [];
      list.push(row);
      byApiKey.set(row.apiKeyId, list);
    }
    return byApiKey;
  } catch {
    return new Map();
  }
}

function findClosestRecordedCost(
  candidates: RecordedCostRow[] | undefined,
  timestampMs: number,
  usedRecordedRows: Set<number>
): RecordedCostRow | null {
  if (!candidates?.length || !Number.isFinite(timestampMs)) return null;

  let best: RecordedCostRow | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (usedRecordedRows.has(candidate.rowId)) continue;
    const delta = Math.abs(candidate.timestamp - timestampMs);
    if (delta > RECORDED_COST_MATCH_TOLERANCE_MS) {
      if (candidate.timestamp > timestampMs + RECORDED_COST_MATCH_TOLERANCE_MS) break;
      continue;
    }
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }

  if (best) usedRecordedRows.add(best.rowId);
  return best;
}

async function calculateUsageRowCost(provider: string, row: UsageCostRow): Promise<number> {
  const model = typeof row.model === "string" ? row.model : "";
  if (!model) return 0;

  return calculateCost(
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

async function getConnectionSpendUsdSince(
  provider: string,
  connectionId: string,
  sinceIso: string,
  nowMs: number
): Promise<{ costUsd: number; requests: number }> {
  const connectionIds = resolveSpendConnectionIds(provider, connectionId, sinceIso, nowMs);
  const params: Record<string, unknown> = {
    provider,
    sinceIso,
    nowIso: new Date(nowMs).toISOString(),
  };
  const connectionPlaceholders = appendNamedPlaceholders(params, "connection", connectionIds);
  const rows = getDbInstance()
    .prepare(
      `
      SELECT
        id,
        timestamp,
        api_key_id as apiKeyId,
        connection_id as connectionId,
        model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(tokens_input, 0) as inputTokens,
        COALESCE(tokens_output, 0) as outputTokens,
        COALESCE(tokens_cache_read, 0) as cacheReadTokens,
        COALESCE(tokens_cache_creation, 0) as cacheCreationTokens,
        COALESCE(tokens_reasoning, 0) as reasoningTokens
      FROM usage_history
      WHERE connection_id IN (${connectionPlaceholders})
        AND LOWER(provider) = LOWER(@provider)
        AND timestamp >= @sinceIso
        AND timestamp <= @nowIso
        AND success = 1
      ORDER BY timestamp ASC, id ASC
    `
    )
    .all(params) as UsageCostRow[];

  let costUsd = 0;
  let requests = rows.length;
  const sinceMs = Date.parse(sinceIso);
  const recordedCostsByApiKey = Number.isFinite(sinceMs)
    ? getRecordedCostsByApiKey(uniqueApiKeyIds(rows), sinceMs, nowMs)
    : new Map<string, RecordedCostRow[]>();
  const usedRecordedRows = new Set<number>();

  for (const row of rows) {
    const usageTimestampMs = Date.parse(row.timestamp ?? "");
    const recordedCost = findClosestRecordedCost(
      typeof row.apiKeyId === "string" ? recordedCostsByApiKey.get(row.apiKeyId) : undefined,
      usageTimestampMs,
      usedRecordedRows
    );
    if (recordedCost) {
      costUsd += Math.max(0, toNumber(recordedCost.cost));
      continue;
    }

    costUsd += await calculateUsageRowCost(provider, row);
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
        ? await getConnectionSpendUsdSince(
            connection.provider,
            connection.id,
            windowStartIso,
            nowMs
          )
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
    costSource: "recorded_cost_history_or_usage_history_pricing",
    primaryWindowName: primary?.windowName ?? null,
    windows,
  };
}
