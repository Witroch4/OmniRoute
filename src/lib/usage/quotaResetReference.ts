import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import {
  getLatestProviderQuotaWindowSnapshot,
  getProviderQuotaWindowStartIso,
} from "@/lib/db/quotaResetEvents";
import { getProviderQuotaResetReferences } from "@/lib/db/quotaResetReferences";
import type { ProviderQuotaResetReferences } from "@/shared/validation/quotaResetReferenceSchemas";

type JsonRecord = Record<string, unknown>;

export interface QuotaResetReferenceDeps {
  now: () => number;
  getProviderConnectionById: (id: string) => Promise<unknown>;
  getProviderLimitsCache: (id: string) => ProviderLimitsCacheEntry | null;
  getQuotaResetReferences?: () => ProviderQuotaResetReferences;
}

export async function resolveProviderQuotaResetReference(
  provider: string,
  deps: QuotaResetReferenceDeps
) {
  const reference = (deps.getQuotaResetReferences ?? getProviderQuotaResetReferences)()[provider];
  if (!reference) return null;
  const rawConnection = await deps.getProviderConnectionById(reference.connectionId);
  const connection =
    rawConnection && typeof rawConnection === "object" ? (rawConnection as JsonRecord) : null;
  if (!connection || connection.provider !== provider || connection.isActive === false) {
    throw new Error(`Quota reset reference for ${provider} is missing or inactive.`);
  }
  const cache = deps.getProviderLimitsCache(reference.connectionId);
  const rawQuota = cache?.quotas?.[reference.windowKey];
  let quota: JsonRecord | null =
    rawQuota && typeof rawQuota === "object" ? (rawQuota as JsonRecord) : null;
  const snapshot = getLatestProviderQuotaWindowSnapshot(
    reference.connectionId,
    reference.windowKey,
    deps.now()
  );
  if (
    snapshot &&
    Date.parse(snapshot.createdAt ?? "") >= Date.parse(cache?.fetchedAt ?? "1970-01-01")
  ) {
    quota = {
      ...quota,
      remaining: snapshot.remainingPercentage,
      used: 100 - Number(snapshot.remainingPercentage),
      total: 100,
      resetAt: snapshot.nextResetAt,
    };
  }
  const resetMs = typeof quota?.resetAt === "string" ? Date.parse(quota.resetAt) : NaN;
  if (!quota || !Number.isFinite(resetMs)) {
    throw new Error(`Quota reset reference for ${provider} has no observed window.`);
  }
  const resetAtIso = new Date(resetMs).toISOString();
  const windowStartIso =
    getProviderQuotaWindowStartIso(
      reference.connectionId,
      resetAtIso,
      deps.now(),
      reference.windowKey
    ) ?? new Date(resetMs - reference.windowDurationMs).toISOString();
  return { reference, connection, cache, quota, resetAtIso, windowStartIso };
}
