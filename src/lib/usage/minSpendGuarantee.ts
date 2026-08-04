import { getApiKeyUsdSpendSince } from "./apiKeyUsageLimits";

/**
 * Minimum-spend guarantee (floor that overrides the provider quota cutoff).
 *
 * A key configured with a min-spend guarantee is allowed to spend AT LEAST
 * `minSpendGuaranteeUsd` per rolling weekly window, routing past the provider
 * quota cutoff if necessary (the same effect the bypass scope grants, but
 * gated on spend and independent of the scope). Once the key's window spend
 * reaches the floor, the normal cutoff applies again.
 *
 * Scope is per-key and GLOBAL across providers; ALL window spend counts toward
 * the floor. A hard USD ceiling (usageLimitEnabled) still limits and is
 * enforced earlier in `enforceApiKeyPolicy`, before credential selection.
 *
 * Masking is unaffected: `@@om-usage` never reads the guarantee, so a key
 * routing past the cutoff still reports 0% like any other key.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface MinSpendGuaranteeMetadataLike {
  id?: string | null;
  minSpendGuaranteeEnabled?: boolean;
  minSpendGuaranteeUsd?: number | null;
}

/**
 * Whether the guarantee should force selection past the provider cutoff right
 * now: the key has an enabled floor > 0 and its spend in the current weekly
 * window is still below that floor. Returns false immediately (no DB query)
 * when the key has no guarantee configured.
 */
export interface MinSpendGuaranteeDeps {
  getSpendSince?: (
    apiKeyId: string,
    sinceIso: string,
    options?: { basis?: "normalized" | "real" }
  ) => Promise<number>;
}

export async function isMinSpendGuaranteeActive(
  metadata: MinSpendGuaranteeMetadataLike | null | undefined,
  now: number = Date.now(),
  deps: MinSpendGuaranteeDeps = {}
): Promise<boolean> {
  if (!metadata || metadata.minSpendGuaranteeEnabled !== true) return false;

  const floorUsd = Number(metadata.minSpendGuaranteeUsd);
  if (!Number.isFinite(floorUsd) || floorUsd <= 0) return false;

  const apiKeyId = typeof metadata.id === "string" ? metadata.id : "";
  if (!apiKeyId) return false;

  const sinceIso = new Date(now - WEEK_MS).toISOString();
  const getSpendSince = deps.getSpendSince ?? getApiKeyUsdSpendSince;
  // Real spend, not normalized: the guarantee decides whether to route past the
  // provider cutoff so the upstream account is genuinely consumed, and its number
  // is never returned to a client.
  const spentUsd = await getSpendSince(apiKeyId, sinceIso, { basis: "real" });
  return spentUsd < floorUsd;
}
