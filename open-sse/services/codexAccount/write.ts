import { getCodexModelScope, type CodexQuotaScope } from "../../config/codexQuotaScopes.ts";
import { updateCodexScopeCooldown } from "@/lib/db/providers";

export interface PersistCodexChildCooldownResult {
  readonly scope: CodexQuotaScope;
  readonly providerSpecificData: Record<string, unknown>;
}

/** Persist one virtual child's cooldown without mutating parent-level health state. */
export async function persistCodexChildCooldown(params: {
  connectionId: string;
  model: string;
  rateLimitedUntil: string;
  /**
   * Fork: `quota_preflight` tags a cooldown written by OmniRoute's own quota cutoff so a key
   * with the bypass scope / an unmet min-spend guarantee can route past it (a real 429, the
   * default `fallback`, still blocks everyone).
   */
  rateLimitSource?: "fallback" | "quota_preflight";
}): Promise<PersistCodexChildCooldownResult | null> {
  if (params.model.trim().length === 0) return null;
  const scope = getCodexModelScope(params.model);
  const providerSpecificData = await updateCodexScopeCooldown(
    params.connectionId,
    scope,
    params.rateLimitedUntil,
    params.rateLimitSource
  );
  return providerSpecificData ? { scope, providerSpecificData } : null;
}
