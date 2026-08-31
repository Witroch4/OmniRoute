import { getDbInstance } from "@/lib/db/core";
import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { getProviderQuotaWindowStartIso } from "@/lib/db/quotaResetEvents";
import { calculateCost } from "./costCalculator";
import {
  applyFamilyMultiplier,
  loadFamilyMultiplierRules,
  resolveFamilyMultiplier,
  type FamilyMultiplierRule,
} from "./modelFamilyMultiplier";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const FORTALEZA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiKeyUsageLimitMetadata {
  id: string;
  allowedConnections?: string[] | null;
  preferredProvider?: string | null;
  usageLimitEnabled?: boolean;
  dailyUsageLimitUsd?: number | null;
  weeklyUsageLimitUsd?: number | null;
}

export interface ApiKeyUsageLimitStatus {
  enabled: boolean;
  dailyLimitUsd: number | null;
  weeklyLimitUsd: number | null;
  dailySpentUsd: number;
  weeklySpentUsd: number;
  dailyWindowStartIso: string;
  dailyResetAtIso: string;
  weeklyWindowStartIso: string;
  weeklyResetAtIso: string | null;
  dailyExceeded: boolean;
  weeklyExceeded: boolean;
}

export interface ApiKeyUsageLimitDeps {
  now?: () => number;
  getProviderConnectionById?: (connectionId: string) => Promise<unknown>;
  getProviderConnections?: (filter?: Record<string, unknown>) => Promise<unknown[]>;
  getProviderLimitsCache?: (connectionId: string) => ProviderLimitsCacheEntry | null;
  getAllProviderLimitsCache?: () => Record<string, ProviderLimitsCacheEntry>;
}

interface UsageCostRow {
  provider: string | null;
  model: string | null;
  serviceTier: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
}

interface WeeklyResetCandidate {
  connectionId: string;
  provider: string;
  resetAtIso: string;
  observedWindowStartIso: string | null;
}

interface QuotaSnapshotRow {
  remainingPercentage: number | null;
  nextResetAt: string | null;
  createdAt: string | null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeLimitUsd(value: unknown): number | null {
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not configured";
  return `$${value.toFixed(2)}`;
}

function getUsagePercent(spentUsd: number, limitUsd: number | null): number | null {
  if (limitUsd === null || !Number.isFinite(limitUsd) || limitUsd <= 0) return null;
  return (spentUsd / limitUsd) * 100;
}

function formatUsagePercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "Unavailable";
  return `${Math.round(percent)}%`;
}

function formatLeftPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "Unavailable";
  return `${Math.round(100 - clampPercent(percent))}% left`;
}

function formatResetIn(resetAt: string | null, now = Date.now()): string {
  if (!resetAt) return "unknown";
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return "unknown";

  const deltaMs = resetMs - now;
  if (deltaMs <= 0) return "now";

  const minuteMs = 60_000;
  const totalMinutes = Math.max(1, Math.ceil(deltaMs / minuteMs));
  const dayMinutes = 24 * 60;
  const days = Math.floor(totalMinutes / dayMinutes);
  const hours = Math.floor((totalMinutes % dayMinutes) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function resetDay(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function getFortalezaDayStartIso(nowMs = Date.now()): string {
  const fortalezaLocal = new Date(nowMs - FORTALEZA_UTC_OFFSET_MS);
  return new Date(
    Date.UTC(
      fortalezaLocal.getUTCFullYear(),
      fortalezaLocal.getUTCMonth(),
      fortalezaLocal.getUTCDate(),
      3,
      0,
      0,
      0
    )
  ).toISOString();
}

export function getFortalezaDayResetIso(nowMs = Date.now()): string {
  return new Date(Date.parse(getFortalezaDayStartIso(nowMs)) + DAY_MS).toISOString();
}

export function getRollingWeekStartIso(nowMs = Date.now()): string {
  return new Date(nowMs - WEEK_MS).toISOString();
}

function normalizeQuotaName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeProvider(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (normalized === "cc" || normalized === "claude-code") return "claude";
  return normalized;
}

/** Every parseable `resetAt` (ms) advertised by a weekly, non-sonnet quota window. */
function collectWeeklyQuotaResetAts(quotas: unknown): number[] {
  const quotaEntries: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(quotas)) {
    for (const item of quotas) {
      const quota = asRecord(item);
      if (!quota) continue;
      const name = typeof quota.name === "string" ? quota.name : "";
      quotaEntries.push([name, quota]);
    }
  } else {
    const quotaMap = asRecord(quotas);
    if (quotaMap) {
      for (const [name, value] of Object.entries(quotaMap)) {
        const quota = asRecord(value);
        if (quota) quotaEntries.push([name, quota]);
      }
    }
  }

  const resetAts: number[] = [];
  for (const [name, quota] of quotaEntries) {
    const label = normalizeQuotaName(`${name} ${typeof quota.name === "string" ? quota.name : ""}`);
    if (!label) continue;
    const isWeekly = label.includes("weekly") || label.includes("7d");
    if (!isWeekly || label.includes("sonnet")) continue;
    const resetAt = typeof quota.resetAt === "string" && quota.resetAt.trim() ? quota.resetAt : "";
    const resetMs = Date.parse(resetAt);
    if (Number.isFinite(resetMs)) resetAts.push(resetMs);
  }
  return resetAts;
}

function findWeeklyQuotaResetAt(quotas: unknown, nowMs: number): string | null {
  for (const resetMs of collectWeeklyQuotaResetAts(quotas)) {
    if (resetMs > nowMs) return new Date(resetMs).toISOString();
  }
  return null;
}

/**
 * True when the cache advertises a weekly window whose reset instant has already
 * elapsed — i.e. the provider has rolled into a new week but this entry still
 * describes the previous one.
 */
function hasElapsedWeeklyQuota(quotas: unknown, nowMs: number): boolean {
  return collectWeeklyQuotaResetAts(quotas).some((resetMs) => resetMs <= nowMs);
}

/**
 * Latest weekly reset OmniRoute has actually observed for `connectionId`, taken
 * from `quota_snapshots`.
 *
 * The provider-limits cache is the primary source for the weekly window, but it
 * only advances when a live usage fetch succeeds. Anthropic's OAuth usage
 * endpoint answers `429` under load (`markClaudeOauthUsage429`) and both
 * `fetchAndPersistProviderLimits` and `syncAllProviderLimits` deliberately keep
 * the PREVIOUS entry on a failed fetch rather than wiping it. So after a real
 * weekly reset the cached `resetAt` can stay pinned in the past indefinitely,
 * `findWeeklyQuotaResetAt` returns null, and the caller silently degrades to a
 * rolling 7d window that still counts spend from the week the provider already
 * reset — keeping a USD-limited API key blocked at >100% forever.
 *
 * `quota_snapshots` does not have that failure mode: it is written from real
 * response headers on every request, so it observes the reset immediately.
 */
function getSnapshotWeeklyResetAt(connectionId: string, nowMs: number): string | null {
  if (!connectionId) return null;

  try {
    const row = getDbInstance()
      .prepare(
        `
        SELECT next_reset_at as nextResetAt
        FROM quota_snapshots
        WHERE connection_id = @connectionId
          AND LOWER(window_key) LIKE '%weekly%'
          AND LOWER(window_key) NOT LIKE '%sonnet%'
          AND next_reset_at IS NOT NULL
          AND created_at <= @nowIso
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      )
      .get({ connectionId, nowIso: new Date(nowMs).toISOString() }) as
      { nextResetAt?: string | null } | undefined;

    const resetMs = Date.parse(row?.nextResetAt ?? "");
    return Number.isFinite(resetMs) && resetMs > nowMs ? new Date(resetMs).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Weekly reset for a connection: the cached provider window when it is still
 * current, otherwise the newer reset observed in `quota_snapshots`.
 *
 * The snapshot path is deliberately gated on the cache having held an ELAPSED
 * weekly window: a connection whose cache never advertised a weekly quota must
 * not gain one here (that would hand keys a provider-anchored window they never
 * had, changing the window for providers unrelated to this bug).
 */
function resolveWeeklyResetAt(quotas: unknown, connectionId: string, nowMs: number): string | null {
  const cachedResetAt = findWeeklyQuotaResetAt(quotas, nowMs);
  if (cachedResetAt) return cachedResetAt;
  if (!hasElapsedWeeklyQuota(quotas, nowMs)) return null;
  return getSnapshotWeeklyResetAt(connectionId, nowMs);
}

function connectionFromValue(value: unknown): { id: string; provider: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : "";
  const provider = typeof record.provider === "string" ? record.provider : "";
  if (!id || !provider || record.isActive === false) return null;
  return { id, provider };
}

function isWeeklyQuotaResetSnapshot(row: QuotaSnapshotRow, targetResetAtIso: string): boolean {
  const targetDay = resetDay(targetResetAtIso);
  if (!targetDay) return false;
  return resetDay(row.nextResetAt) === targetDay;
}

function getObservedWeeklyWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs: number
): string | null {
  if (!connectionId || !targetResetAtIso) return null;

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
      .all({ connectionId, nowIso: new Date(nowMs).toISOString() }) as QuotaSnapshotRow[];

    let observedStartIso: string | null = null;
    let previousUsedPercent: number | null = null;
    // See the same guard in `getObservedQuotaWindowStartIso`: the first snapshot
    // carrying the target reset is the reset itself ONLY when we were already
    // watching this connection through the previous window. A connection born
    // mid-window (re-login mints a new id) would otherwise report its own birth
    // as the window start, truncating the window and under-enforcing the cap
    // over the missing days.
    let watchedPreviousWindow = false;
    let sawTargetWindowRow = false;

    for (const row of rows) {
      if (!row.createdAt) continue;
      if (!isWeeklyQuotaResetSnapshot(row, targetResetAtIso)) {
        if (!sawTargetWindowRow) watchedPreviousWindow = true;
        continue;
      }
      sawTargetWindowRow = true;
      const remaining = toNumber(row.remainingPercentage);
      const usedPercent = clampPercent(100 - remaining);

      if (previousUsedPercent !== null) {
        const droppedToResetFloor = usedPercent <= 1 && previousUsedPercent > usedPercent;
        const significantDrop = previousUsedPercent - usedPercent >= 5;
        if (droppedToResetFloor || significantDrop) {
          observedStartIso = row.createdAt;
        }
      } else if (watchedPreviousWindow) {
        observedStartIso = row.createdAt;
      }

      previousUsedPercent = usedPercent;
    }

    return observedStartIso;
  } catch {
    return null;
  }
}

// Prefer the persisted, provider-observed window start (recorded by
// quotaResetEvents on real reset transitions); fall back to inferring it from
// historical snapshots when no observed event is available yet.
function getWeeklyWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs: number
): string | null {
  return (
    getProviderQuotaWindowStartIso(connectionId, targetResetAtIso, nowMs) ??
    getObservedWeeklyWindowStartIso(connectionId, targetResetAtIso, nowMs)
  );
}

async function resolveDeps(deps: ApiKeyUsageLimitDeps): Promise<Required<ApiKeyUsageLimitDeps>> {
  const providers =
    deps.getProviderConnectionById && deps.getProviderConnections
      ? null
      : await import("@/lib/db/providers");
  const providerLimits =
    deps.getProviderLimitsCache && deps.getAllProviderLimitsCache
      ? null
      : await import("@/lib/db/providerLimits");

  return {
    now: deps.now ?? Date.now,
    getProviderConnectionById:
      deps.getProviderConnectionById ?? providers!.getProviderConnectionById,
    getProviderConnections: deps.getProviderConnections ?? providers!.getProviderConnections,
    getProviderLimitsCache: deps.getProviderLimitsCache ?? providerLimits!.getProviderLimitsCache,
    getAllProviderLimitsCache:
      deps.getAllProviderLimitsCache ?? providerLimits!.getAllProviderLimitsCache,
  };
}

async function getProviderWeeklyWindow(
  metadata: ApiKeyUsageLimitMetadata,
  deps: Required<ApiKeyUsageLimitDeps>,
  nowMs: number
): Promise<{ resetAtIso: string | null; windowStartIso: string | null }> {
  const allowedConnections = Array.isArray(metadata.allowedConnections)
    ? metadata.allowedConnections.filter((id) => typeof id === "string" && id.trim())
    : [];

  const resetCandidates: WeeklyResetCandidate[] = [];
  if (allowedConnections.length > 0) {
    for (const connectionId of allowedConnections) {
      const connection = connectionFromValue(await deps.getProviderConnectionById(connectionId));
      if (!connection) continue;
      const resetAt = resolveWeeklyResetAt(
        deps.getProviderLimitsCache(connection.id)?.quotas,
        connection.id,
        nowMs
      );
      if (resetAt) {
        resetCandidates.push({
          connectionId: connection.id,
          provider: connection.provider,
          resetAtIso: resetAt,
          observedWindowStartIso: getWeeklyWindowStartIso(connection.id, resetAt, nowMs),
        });
      }
    }
  } else {
    const caches = deps.getAllProviderLimitsCache();
    const connections = await deps.getProviderConnections({ isActive: true });
    for (const rawConnection of connections) {
      const connection = connectionFromValue(rawConnection);
      if (!connection) continue;
      const resetAt = resolveWeeklyResetAt(caches[connection.id]?.quotas, connection.id, nowMs);
      if (resetAt) {
        resetCandidates.push({
          connectionId: connection.id,
          provider: connection.provider,
          resetAtIso: resetAt,
          observedWindowStartIso: getWeeklyWindowStartIso(connection.id, resetAt, nowMs),
        });
      }
    }
  }

  const preferredProvider = normalizeProvider(metadata.preferredProvider);
  const scopedCandidates = preferredProvider
    ? resetCandidates.filter(
        (candidate) => normalizeProvider(candidate.provider) === preferredProvider
      )
    : [];
  const candidates = scopedCandidates.length > 0 ? scopedCandidates : resetCandidates;
  const selected =
    candidates
      .sort((left, right) => Date.parse(left.resetAtIso) - Date.parse(right.resetAtIso))
      .at(0) ?? null;
  return {
    resetAtIso: selected?.resetAtIso ?? null,
    windowStartIso: selected?.observedWindowStartIso ?? null,
  };
}

export type SpendBasis = "normalized" | "real";

/**
 * `multiplierRules` is non-null only for `basis: "normalized"` callers (see
 * `getApiKeyUsdSpendSince` below) — a `basis: "real"` caller (the model
 * budget rules' own real-spend check, the min-spend guarantee) must never
 * have its total scaled, since the multiplier exists purely to shape what the
 * client is billed, not what OmniRoute actually spent. Each row's
 * `provider`/`model` is already the EFFECTIVE BILLED pair by the time it
 * reaches here for normalized basis (see the `providerExpr`/`modelExpr`
 * COALESCE in the caller), so resolving the multiplier directly off them is
 * correct — no separate billed-vs-served split needed at this layer.
 */
async function sumUsageCostRows(
  rows: UsageCostRow[],
  multiplierRules: FamilyMultiplierRule[] | null = null
): Promise<number> {
  let total = 0;
  for (const row of rows) {
    const provider = typeof row.provider === "string" ? row.provider : "";
    const model = typeof row.model === "string" ? row.model : "";
    if (!provider || !model) continue;

    let rowCost = await calculateCost(
      provider,
      model,
      {
        input: toNumber(row.promptTokens),
        output: toNumber(row.completionTokens),
        cacheRead: toNumber(row.cacheReadTokens),
        cacheCreation: toNumber(row.cacheCreationTokens),
        reasoning: toNumber(row.reasoningTokens),
      },
      { provider, model, serviceTier: row.serviceTier || "standard" }
    );

    if (multiplierRules) {
      const multiplier = resolveFamilyMultiplier(multiplierRules, provider, model);
      rowCost = applyFamilyMultiplier(rowCost, multiplier);
    }

    total += rowCost;
  }
  return roundUsd(total);
}

/**
 * Sum an API key's USD spend since `sinceIso`.
 *
 * `basis: "normalized"` (the default) prices each row by the model the CLIENT
 * asked for — `billed_provider`/`billed_model` when a model budget rule
 * redirected the request, the real pair otherwise. This is what every
 * client-facing surface reports and what the key's USD quota is measured
 * against, so a key that gets silently downgraded to Sonnet keeps burning its
 * quota at Opus rates.
 *
 * `basis: "real"` prices by the model that actually ran. It drives the model
 * budget rules themselves (a redirected row must count toward the family that
 * SERVED it, or the opus -> sonnet -> haiku ladder could never advance past its
 * first rung) and the min-spend guarantee. It is admin-only and must never
 * reach a client-facing response.
 *
 * `basis: "normalized"` is also where the per-key model-family multiplier
 * (migration 128) applies — every row here is already priced at the BILLED
 * pair, so its family multiplier (if any) scales that row's cost before the
 * sum. `basis: "real"` never loads multiplier rules at all, since the
 * multiplier must never touch what OmniRoute actually paid upstream.
 */
export async function getApiKeyUsdSpendSince(
  apiKeyId: string,
  sinceIso: string,
  options: { basis?: SpendBasis } = {}
): Promise<number> {
  if (!apiKeyId) return 0;
  const basis = options.basis ?? "normalized";
  const providerExpr =
    basis === "normalized" ? "COALESCE(NULLIF(billed_provider, ''), provider)" : "provider";
  const modelExpr = basis === "normalized" ? "COALESCE(NULLIF(billed_model, ''), model)" : "model";

  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT
        LOWER(${providerExpr}) as provider,
        LOWER(${modelExpr}) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM usage_history
      WHERE api_key_id = @apiKeyId
        AND timestamp >= @sinceIso
        AND success = 1
      GROUP BY LOWER(${providerExpr}), LOWER(${modelExpr}), serviceTier
    `
    )
    .all({ apiKeyId, sinceIso }) as UsageCostRow[];

  const multiplierRules = basis === "normalized" ? await loadFamilyMultiplierRules(apiKeyId) : null;
  return sumUsageCostRows(rows, multiplierRules);
}

const NORMALIZED_SPEND_CACHE_TTL_MS = 60_000;
interface NormalizedSpendCacheEntry {
  value: number;
  expiresAt: number;
}
const normalizedSpendCache = new Map<string, NormalizedSpendCacheEntry>();

/** Testing seam: clears the short-TTL cache below between test cases. */
export function clearApiKeyNormalizedSpendCacheForTests(): void {
  normalizedSpendCache.clear();
}

/**
 * Cached wrapper around `getApiKeyUsdSpendSince(..., { basis: "normalized" })`
 * for request-path callers that need the figure on EVERY request — the live
 * budget-enforcement gate (`checkBudgetNormalized` in `costRules.ts`, called
 * from `apiKeyPolicy.ts`'s Check 4) — and for the client-facing self-service
 * status read (`apiKeySelfService.ts`), which both moved off
 * `domain_cost_history.billed_cost` (final-review Finding 1: that column is
 * frozen at write time, so it silently under/over-enforces after any
 * multiplier edit — see the doc comment on `checkBudgetNormalized`).
 *
 * A 60s TTL — same pattern and magnitude as `modelBudgetRouting.ts`'s
 * `spendCache` — bounds the cost of paying a full `GROUP BY` +
 * per-group `calculateCost` pass on every single proxied request, while
 * still keeping a multiplier edit's effect on enforcement bounded to at most
 * one TTL window (never "up to a month" the way the frozen write-time figure
 * was). Keyed on `${apiKeyId}::${sinceIso}` so different windows (a budget
 * period roll, a different reset boundary) never share a stale entry.
 */
export async function getApiKeyUsdSpendSinceCached(
  apiKeyId: string,
  sinceIso: string,
  now: number = Date.now()
): Promise<number> {
  if (!apiKeyId) return 0;
  const key = `${apiKeyId}::${sinceIso}`;
  const cached = normalizedSpendCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await getApiKeyUsdSpendSince(apiKeyId, sinceIso);
  normalizedSpendCache.set(key, { value, expiresAt: now + NORMALIZED_SPEND_CACHE_TTL_MS });
  return value;
}

/**
 * Real USD spend for one provider + model family (glob over the bare model id),
 * for one API key, since `sinceIso`. Always priced by the model that actually
 * ran — see the `basis` note on getApiKeyUsdSpendSince for why the rules must
 * use real rather than normalized spend.
 */
export async function getApiKeyFamilyRealSpendSince(
  apiKeyId: string,
  provider: string,
  familyGlob: string,
  sinceIso: string
): Promise<number> {
  if (!apiKeyId || !provider || !familyGlob) return 0;
  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM usage_history
      WHERE api_key_id = @apiKeyId
        AND timestamp >= @sinceIso
        AND success = 1
        AND LOWER(provider) = @provider
        AND LOWER(model) GLOB @familyGlob
      GROUP BY LOWER(provider), LOWER(model), serviceTier
    `
    )
    .all({
      apiKeyId,
      sinceIso,
      provider: provider.toLowerCase(),
      familyGlob: familyGlob.toLowerCase(),
    }) as UsageCostRow[];

  return sumUsageCostRows(rows);
}

/**
 * The single definition of the weekly-window fallback chain: the observed provider
 * reset when one is known, otherwise a rolling 7 days. Pure — takes an
 * already-fetched `weeklyWindow` rather than fetching one itself, so callers that
 * already paid for a `getProviderWeeklyWindow` lookup never pay for it twice.
 */
function resolveWeeklyWindowStartIso(
  weeklyWindow: { resetAtIso: string | null; windowStartIso: string | null },
  now: number
): string {
  if (weeklyWindow.windowStartIso) return weeklyWindow.windowStartIso;
  if (weeklyWindow.resetAtIso) {
    return new Date(Date.parse(weeklyWindow.resetAtIso) - WEEK_MS).toISOString();
  }
  return getRollingWeekStartIso(now);
}

/**
 * Start of the API key's current weekly window: the observed provider reset when
 * one is known, otherwise a rolling 7 days. Shared by the key's USD quota and by
 * model budget rules so both reset as a single event.
 *
 * Pass `precomputedWeeklyWindow` when the caller already fetched
 * `getProviderWeeklyWindow` for this metadata/now (e.g. `getApiKeyUsageLimitStatus`,
 * which also needs `resetAtIso`) to avoid a second round of connection lookups.
 * Callers without one (e.g. the model budget rules) get it fetched here.
 */
export async function getApiKeyWeeklyWindowStartIso(
  metadata: ApiKeyUsageLimitMetadata,
  deps: ApiKeyUsageLimitDeps = {},
  now: number = Date.now(),
  precomputedWeeklyWindow?: { resetAtIso: string | null; windowStartIso: string | null }
): Promise<string> {
  if (precomputedWeeklyWindow) {
    return resolveWeeklyWindowStartIso(precomputedWeeklyWindow, now);
  }
  const resolvedDeps = await resolveDeps(deps);
  const weeklyWindow = await getProviderWeeklyWindow(metadata, resolvedDeps, now);
  return resolveWeeklyWindowStartIso(weeklyWindow, now);
}

export interface ApiKeyWeeklyWindowResolution {
  /** Start of the window a caller should filter/report from. */
  windowStartIso: string;
  /** Provider-observed reset instant, or null when no reset has been observed yet. */
  resetAtIso: string | null;
  /**
   * True when `windowStartIso` is anchored to an actual provider-observed
   * reset (cache or `quota_snapshots`). False means `resolveWeeklyWindowStartIso`
   * fell all the way back to a rolling 7 days (`getRollingWeekStartIso`) because
   * no in-scope connection has ever advertised/observed a weekly reset — e.g. a
   * fresh connection or an empty provider-limits cache. Callers that label this
   * window for end users (the Cost Explorer "since reset" range, the API key
   * quota card) must not present a `false` result as "since the provider
   * reset" — the number is real, but the boundary is a guess, not an
   * observation, and showing it unlabeled would silently misrepresent it.
   */
  isObserved: boolean;
}

/**
 * Public entry point for callers outside the USD-quota path that need the
 * key's current weekly window plus whether it is a real observed reset or a
 * rolling-7d fallback — e.g. the Cost Explorer's "since reset" range, which
 * must resolve through the SAME window the key's USD quota uses (not
 * reimplement day arithmetic) and must know when to warn instead of silently
 * labeling a rolling window as "since reset".
 */
export async function resolveApiKeyWeeklyWindow(
  metadata: ApiKeyUsageLimitMetadata,
  deps: ApiKeyUsageLimitDeps = {},
  now: number = Date.now()
): Promise<ApiKeyWeeklyWindowResolution> {
  const resolvedDeps = await resolveDeps(deps);
  const weeklyWindow = await getProviderWeeklyWindow(metadata, resolvedDeps, now);
  const windowStartIso = await getApiKeyWeeklyWindowStartIso(
    metadata,
    resolvedDeps,
    now,
    weeklyWindow
  );
  return {
    windowStartIso,
    resetAtIso: weeklyWindow.resetAtIso,
    isObserved: weeklyWindow.resetAtIso !== null,
  };
}

export async function getApiKeyUsageLimitStatus(
  metadata: ApiKeyUsageLimitMetadata,
  deps: ApiKeyUsageLimitDeps = {}
): Promise<ApiKeyUsageLimitStatus> {
  const resolvedDeps = await resolveDeps(deps);
  const now = resolvedDeps.now();
  const dailyWindowStartIso = getFortalezaDayStartIso(now);
  const dailyResetAtIso = getFortalezaDayResetIso(now);
  const weeklyWindow = await getProviderWeeklyWindow(metadata, resolvedDeps, now);
  const weeklyResetAtIso = weeklyWindow.resetAtIso;
  const weeklyWindowStartIso = await getApiKeyWeeklyWindowStartIso(
    metadata,
    resolvedDeps,
    now,
    weeklyWindow
  );
  const dailyLimitUsd = normalizeLimitUsd(metadata.dailyUsageLimitUsd);
  const weeklyLimitUsd = normalizeLimitUsd(metadata.weeklyUsageLimitUsd);
  const enabled = metadata.usageLimitEnabled === true;

  const [dailySpentUsd, weeklySpentUsd] = await Promise.all([
    getApiKeyUsdSpendSince(metadata.id, dailyWindowStartIso),
    getApiKeyUsdSpendSince(metadata.id, weeklyWindowStartIso),
  ]);

  return {
    enabled,
    dailyLimitUsd,
    weeklyLimitUsd,
    dailySpentUsd,
    weeklySpentUsd,
    dailyWindowStartIso,
    dailyResetAtIso,
    weeklyWindowStartIso,
    weeklyResetAtIso,
    dailyExceeded: enabled && dailyLimitUsd !== null && dailySpentUsd >= dailyLimitUsd,
    weeklyExceeded: enabled && weeklyLimitUsd !== null && weeklySpentUsd >= weeklyLimitUsd,
  };
}

export function buildApiKeyUsageLimitText(
  status: ApiKeyUsageLimitStatus,
  now = Date.now()
): string {
  return [
    "Daily quota",
    formatUsd(status.dailyLimitUsd),
    "Daily spent",
    formatUsd(status.dailySpentUsd),
    "Daily used",
    formatUsagePercent(getUsagePercent(status.dailySpentUsd, status.dailyLimitUsd)),
    `Resets in ${formatResetIn(status.dailyResetAtIso, now)}`,
    "",
    "Weekly quota",
    formatUsd(status.weeklyLimitUsd),
    "Weekly spent",
    formatUsd(status.weeklySpentUsd),
    "Weekly used",
    formatUsagePercent(getUsagePercent(status.weeklySpentUsd, status.weeklyLimitUsd)),
    `Resets in ${formatResetIn(status.weeklyResetAtIso, now)}`,
  ].join("\n");
}

// The om-usage (API) surface caps each "left" percentage at the provider's
// effective remaining after cutoff (capLeftPercent). A provider that is cut off
// on any window then reads as 0% across every quota line — personal included —
// instead of advertising personal quota the caller cannot actually spend, since
// nothing routes while the provider is below its cutoff. capLeftPercent === null
// leaves the value untouched (callers that want the raw personal quota).
function formatLeftPercentWithCap(
  usedPercent: number | null,
  capLeftPercent: number | null
): string {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return "Unavailable";
  let left = 100 - clampPercent(usedPercent);
  if (capLeftPercent !== null && Number.isFinite(capLeftPercent)) {
    left = Math.min(left, capLeftPercent);
  }
  return `${Math.round(clampPercent(left))}% left`;
}

export function buildApiKeyUsageLimitPercentText(
  status: ApiKeyUsageLimitStatus,
  now = Date.now(),
  capLeftPercent: number | null = null
): string {
  return [
    "Daily",
    formatLeftPercentWithCap(
      getUsagePercent(status.dailySpentUsd, status.dailyLimitUsd),
      capLeftPercent
    ),
    `⏱ reset in ${formatResetIn(status.dailyResetAtIso, now)}`,
    "",
    "Weekly",
    formatLeftPercentWithCap(
      getUsagePercent(status.weeklySpentUsd, status.weeklyLimitUsd),
      capLeftPercent
    ),
    `⏱ reset in ${formatResetIn(status.weeklyResetAtIso, now)}`,
  ].join("\n");
}

function buildUsageLimitExceededMessage(
  status: ApiKeyUsageLimitStatus,
  now = Date.now(),
  options: { showUsd?: boolean } = {}
): string {
  const showUsd = options.showUsd !== false;
  if (status.dailyExceeded && status.dailyLimitUsd !== null) {
    const percent = formatUsagePercent(getUsagePercent(status.dailySpentUsd, status.dailyLimitUsd));
    if (!showUsd) {
      return `This API key reached its daily usage quota (${percent}). Resets in ${formatResetIn(status.dailyResetAtIso, now)}. Choose another allowed model after reset.`;
    }
    return `This API key reached its daily USD usage quota (${formatUsd(status.dailySpentUsd)} of ${formatUsd(status.dailyLimitUsd)}, ${percent}). Resets in ${formatResetIn(status.dailyResetAtIso, now)}. Choose another allowed model after reset.`;
  }
  if (status.weeklyExceeded && status.weeklyLimitUsd !== null) {
    const percent = formatUsagePercent(
      getUsagePercent(status.weeklySpentUsd, status.weeklyLimitUsd)
    );
    if (!showUsd) {
      return `This API key reached its weekly usage quota (${percent}). Resets in ${formatResetIn(status.weeklyResetAtIso, now)}. Choose another allowed model after reset.`;
    }
    return `This API key reached its weekly USD usage quota (${formatUsd(status.weeklySpentUsd)} of ${formatUsd(status.weeklyLimitUsd)}, ${percent}). Resets in ${formatResetIn(status.weeklyResetAtIso, now)}. Choose another allowed model after reset.`;
  }
  return showUsd
    ? "This API key reached its USD usage quota. Choose another allowed model or wait for quota reset."
    : "This API key reached its usage quota. Choose another allowed model or wait for quota reset.";
}

function isAnthropicMessagesRequest(request: Request): boolean {
  if (request.headers.has("anthropic-version")) return true;
  try {
    return new URL(request.url).pathname.endsWith("/v1/messages");
  } catch {
    return false;
  }
}

export function buildApiKeyUsageLimitRejection(
  request: Request,
  status: ApiKeyUsageLimitStatus,
  now = Date.now(),
  options: { showUsd?: boolean } = {}
): Response {
  const message = sanitizeErrorMessage(buildUsageLimitExceededMessage(status, now, options));
  if (isAnthropicMessagesRequest(request)) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message,
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(JSON.stringify(buildErrorBody(400, message)), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export async function buildApiKeyUsageLimitPolicyRejection(
  request: Request,
  metadata: ApiKeyUsageLimitMetadata
): Promise<Response | null> {
  const status = await getApiKeyUsageLimitStatus(metadata);
  if (!status.enabled || (!status.dailyExceeded && !status.weeklyExceeded)) return null;
  return buildApiKeyUsageLimitRejection(request, status, Date.now(), {
    showUsd: false,
  });
}
