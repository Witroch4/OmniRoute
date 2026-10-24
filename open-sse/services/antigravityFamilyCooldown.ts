/**
 * Persist Antigravity/agy quota cooldowns per model family (gemini vs claude)
 * on the connection row, without cooling the whole account.
 */
import {
  isModelLocked,
  isModelLockedOnlyForReason,
  lockModel,
  QUOTA_PREFLIGHT_LOCK_REASON,
} from "./accountFallback.ts";
import { getAntigravityQuotaFamily, isAntigravityQuotaProvider } from "./antigravityQuotaFamily.ts";

type JsonRecord = Record<string, unknown>;

const FAMILY_PSD_KEY = "antigravityFamilyRateLimitedUntil";
// Fork (min-spend guarantee / bypass scope): which families' cooldown was written by OmniRoute's
// own quota preflight (value QUOTA_PREFLIGHT_LOCK_REASON). Absent = the upstream imposed it.
const FAMILY_SOURCE_PSD_KEY = "antigravityFamilyRateLimitSource";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseUntilMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

function dummyModelForFamily(family: "gemini" | "claude"): string {
  return family === "gemini" ? "gemini-family-lock" : "claude-family-lock";
}

function lockAntigravityFamilyModel(
  connectionId: string,
  model: string,
  reason: string,
  cooldownMs: number
): void {
  lockModel("agy", connectionId, model, reason, cooldownMs);
  lockModel("antigravity", connectionId, model, reason, cooldownMs);
}

export async function persistAntigravityFamilyCooldown(params: {
  connectionId: string;
  model: string;
  rateLimitedUntil: string;
  /** Fork: set by the quota preflight only; omitted for a cooldown the upstream imposed. */
  source?: typeof QUOTA_PREFLIGHT_LOCK_REASON;
}): Promise<JsonRecord | null> {
  if (!params.model.trim()) return null;
  const family = getAntigravityQuotaFamily(params.model);
  if (family === "other") return null;

  const { getProviderConnectionById, updateProviderConnection } =
    await import("@/lib/db/providers");
  const conn = (await getProviderConnectionById(params.connectionId)) as {
    provider?: string;
    providerSpecificData?: JsonRecord | null;
  } | null;
  if (!conn || !isAntigravityQuotaProvider(conn.provider ?? null)) return null;

  const psd = asRecord(conn.providerSpecificData);
  const untils = asRecord(psd[FAMILY_PSD_KEY]);
  const sources = asRecord(psd[FAMILY_SOURCE_PSD_KEY]);
  const existingMs = parseUntilMs(untils[family]);
  const nextMs = parseUntilMs(params.rateLimitedUntil);
  if (!Number.isFinite(nextMs)) return psd;
  const existingActive = Number.isFinite(existingMs) && existingMs > Date.now();
  const existingFromPreflight = sources[family] === QUOTA_PREFLIGHT_LOCK_REASON;
  const writesPreflight = params.source === QUOTA_PREFLIGHT_LOCK_REASON;

  let nextUntil = params.rateLimitedUntil;
  if (writesPreflight) {
    // Our own cutoff never replaces or extends a cooldown the upstream imposed.
    if (existingActive && !existingFromPreflight) return psd;
    if (existingActive && existingMs >= nextMs) return psd;
  } else if (existingActive && existingMs >= nextMs) {
    if (!existingFromPreflight) return psd;
    // Upstream evidence on top of a preflight cooldown: keep the longer deadline, but it is
    // a real cooldown from now on (a bypassing key must stop walking through it).
    nextUntil = String(untils[family]);
  }

  const nextSources = { ...sources };
  if (writesPreflight) nextSources[family] = QUOTA_PREFLIGHT_LOCK_REASON;
  else delete nextSources[family];
  const nextPsd: JsonRecord = {
    ...psd,
    [FAMILY_PSD_KEY]: { ...untils, [family]: nextUntil },
  };
  if (Object.keys(nextSources).length > 0) nextPsd[FAMILY_SOURCE_PSD_KEY] = nextSources;
  else delete nextPsd[FAMILY_SOURCE_PSD_KEY];
  await updateProviderConnection(params.connectionId, { providerSpecificData: nextPsd });
  return nextPsd;
}

/** Fire-and-forget family PSD write. RPM/burst 429s must pass reason !== quota_exhausted. */
export function persistAntigravityFamilyCooldownIfQuota(params: {
  provider?: string | null;
  connectionId: string;
  model?: string | null;
  cooldownMs: number;
  reason?: string | null;
}): void {
  if (!isAntigravityQuotaProvider(params.provider)) return;
  if (!params.model?.trim() || params.cooldownMs <= 0) return;
  if (params.reason != null && params.reason !== "quota_exhausted") return;
  void persistAntigravityFamilyCooldown({
    connectionId: params.connectionId,
    model: params.model,
    rateLimitedUntil: new Date(Date.now() + params.cooldownMs).toISOString(),
  }).catch(() => {});
}

export async function persistAntigravityPreflightFamilyLock(params: {
  provider: string;
  connectionId: string;
  model: string;
  unavailableUntil: string;
}): Promise<void> {
  // Fork: an upstream-imposed lock already in force outranks our own cutoff (nothing to add).
  if (
    isModelLocked("agy", params.connectionId, params.model) &&
    !isModelLockedOnlyForReason(
      "agy",
      params.connectionId,
      params.model,
      QUOTA_PREFLIGHT_LOCK_REASON
    )
  ) {
    return;
  }
  const cooldownMs = Math.max(0, Date.parse(params.unavailableUntil) - Date.now());
  // The preflight origin is recorded (lock reason + persisted source) so a key that may route
  // past the provider cutoff can tell this lock from one the upstream imposed with a real 429.
  lockAntigravityFamilyModel(
    params.connectionId,
    params.model,
    QUOTA_PREFLIGHT_LOCK_REASON,
    cooldownMs
  );
  await persistAntigravityFamilyCooldown({
    connectionId: params.connectionId,
    model: params.model,
    rateLimitedUntil: params.unavailableUntil,
    source: QUOTA_PREFLIGHT_LOCK_REASON,
  });
}

export function rehydrateAntigravityFamilyLocks(
  provider: string,
  connectionId: string,
  providerSpecificData: JsonRecord | null | undefined
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  const untils = asRecord(asRecord(providerSpecificData)[FAMILY_PSD_KEY]);
  const sources = asRecord(asRecord(providerSpecificData)[FAMILY_SOURCE_PSD_KEY]);
  const now = Date.now();
  for (const family of ["gemini", "claude"] as const) {
    const untilMs = parseUntilMs(untils[family]);
    if (!Number.isFinite(untilMs) || untilMs <= now) continue;
    const model = dummyModelForFamily(family);
    const remainingMs = untilMs - now;
    lockAntigravityFamilyModel(
      connectionId,
      model,
      sources[family] === QUOTA_PREFLIGHT_LOCK_REASON
        ? QUOTA_PREFLIGHT_LOCK_REASON
        : "quota_exhausted",
      remainingMs
    );
  }
}

export function rehydrateAntigravityFamilyLocksForConnections(
  provider: string,
  connections: Array<{ id: string; providerSpecificData?: unknown }>
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  for (const conn of connections) {
    rehydrateAntigravityFamilyLocks(
      provider,
      conn.id,
      conn.providerSpecificData as JsonRecord | null | undefined
    );
  }
}

/** Family lock for executor quota exhaustion. Returns false when model is absent. */
export function markAntigravityModelQuotaExhausted(
  connectionId: string,
  retryAfterMs: number,
  model?: string | null
): boolean {
  if (!model) return false;
  lockAntigravityFamilyModel(connectionId, model, "quota_exhausted", retryAfterMs);
  persistAntigravityFamilyCooldownIfQuota({
    provider: "agy",
    connectionId,
    model,
    cooldownMs: retryAfterMs,
    reason: "quota_exhausted",
  });
  return true;
}
