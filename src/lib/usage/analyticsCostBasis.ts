/**
 * Cost Explorer helpers for the fork's billed (normalized) basis and the
 * "since reset" range — extracted from `src/app/api/usage/analytics/route.ts`
 * to keep that route under the file-size cap.
 *
 * @module lib/usage/analyticsCostBasis
 */

import { getApiKeyById } from "@/lib/db/apiKeys";
import { resolveApiKeyWeeklyWindow, type ApiKeyUsageLimitMetadata } from "./apiKeyUsageLimits";

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/**
 * Window resolution for `range=sinceReset` — deliberately NOT a case inside
 * `getRangeStartIso` above. That function is pure day arithmetic and is on
 * the hot path for every other range (including the `presets` recompute
 * loop), so it must stay synchronous and DB-free. "Since reset" instead
 * resolves through `resolveApiKeyWeeklyWindow` (the same helper the API key
 * USD quota is measured against), which is async and hits `provider_limits_cache`
 * / `quota_snapshots` — only this one range pays for that lookup.
 *
 * Scope follows the `apiKeyIds` filter already on the request:
 *   - exactly one key -> that key's own window (its `allowedConnections`,
 *     mirroring `keys/[id]/usage-limits/route.ts`);
 *   - zero or several keys -> the window over all active connections
 *     (`resolveApiKeyWeeklyWindow` already falls back to that when
 *     `allowedConnections` is empty). The provider reset is a property of the
 *     connection/account, not of any one key, so this is the same instant in
 *     practice for a single-connection deployment.
 */
export async function resolveSinceResetRangeWindow(apiKeyIds: string[]): Promise<{
  windowStartIso: string;
  resetAtIso: string | null;
  isObserved: boolean;
  /**
   * False when the caller asked for a single-key-scoped window
   * (`apiKeyIds.length === 1`) but that id didn't resolve to a real key —
   * e.g. `apiKeyIds` held a legacy display name instead of an id
   * (`apiKeyWhere` accepts both: `api_key_name IN (...) OR api_key_id IN
   * (...)`). Previously this silently fell through to the same
   * all-active-connections window a genuinely unscoped request gets, with no
   * signal that the requested scope was never actually honored (final-review
   * Minor 5 — same "explicit flag over silent fallback" class as Finding 2).
   * True whenever the filter is scoped-and-resolved OR genuinely unscoped
   * (0 or 2+ keys, where "all connections" is the correct, intended answer).
   */
  scopeResolved: boolean;
}> {
  let metadata: ApiKeyUsageLimitMetadata = { id: "", allowedConnections: [] };
  let scopeResolved = true;

  if (apiKeyIds.length === 1) {
    const key = await getApiKeyById(apiKeyIds[0]);
    if (key && typeof key.id === "string") {
      metadata = {
        id: key.id,
        allowedModels: Array.isArray(key.allowedModels) ? key.allowedModels : [],
        allowedConnections: Array.isArray(key.allowedConnections) ? key.allowedConnections : [],
      };
    } else {
      scopeResolved = false;
    }
  }

  const resolved = await resolveApiKeyWeeklyWindow(metadata);
  return { ...resolved, scopeResolved };
}

/**
 * Resolve the (provider, model) pair a row should be priced at.
 *
 * `normalized: false` (default) uses the REAL pair — the model that actually
 * served the request. `normalized: true` uses `billed_provider`/`billed_model`
 * — the model the client asked for — falling back to the real pair when a row
 * was never redirected (NULL billed columns). Same COALESCE semantics as
 * `getApiKeyUsdSpendSince`'s `basis` option, so the dashboard and the USD
 * quota can never disagree about what "normalized" means.
 */
export function resolveRowPricingPair(
  row: Record<string, unknown>,
  normalized: boolean
): { provider: string; model: string } {
  if (!normalized) {
    return { provider: toStringValue(row.provider), model: toStringValue(row.model) };
  }
  return {
    provider: toStringValue(row.billedProvider) || toStringValue(row.provider),
    model: toStringValue(row.billedModel) || toStringValue(row.model),
  };
}

/**
 * `costBasis` query param — grouping mode for the Cost Explorer table
 * (`/dashboard/costs`), not a pricing change. `real` (default, unchanged
 * behavior) groups byModel/byProvider by the model that actually SERVED the
 * request. `billed` groups them by what the client ASKED for — the pair a
 * model-budget rule redirected FROM — via `COALESCE(billed*, *)`, same basis
 * `computeUsageRowNormalizedCost`/`getApiKeyUsdSpendSince` already use.
 *
 * Only byModel and byProvider bucket identity is actually provider/model —
 * byAccount (bucketed by connection_id) and byServiceTier (bucketed by
 * service_tier) are basis-invariant: which physical account/tier served a
 * request never depends on what the client asked for, so those two already
 * expose both `cost` and `normalizedCost` per bucket with no regrouping
 * needed (Task 11). byApiKey is bucketed by API key identity, also
 * basis-invariant, for the same reason.
 */
export function parseCostBasis(value: string | null): "real" | "billed" {
  return value === "billed" ? "billed" : "real";
}
