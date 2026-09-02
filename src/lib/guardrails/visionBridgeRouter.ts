/**
 * Vision Bridge Auto-Router
 * Automatically selects the fastest vision-capable model from available models.
 */

import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels";
import { NOAUTH_PROVIDERS } from "@/shared/constants/providers/noauth";
import { APIKEY_PROVIDERS_GATEWAYS } from "@/shared/constants/providers/apikey/gateways";

export interface VisionModelCandidate {
  modelId: string;
  fullName: string; // provider/model format
  priority: number; // lower = better (local models first)
  averageLatencyMs: number;
  lastUsedAt: number;
  successRate: number;
}

export interface LatencyRecord {
  modelId: string;
  latencyMs: number;
  timestamp: number;
  success: boolean;
}

export interface VisionBridgeRouterConfig {
  /** Fixed model to use (overrides auto-routing) */
  fixedModel?: string;
  /** Maximum number of fallback attempts */
  maxFallbackAttempts: number;
  /** Cache TTL for selection decisions (ms) */
  selectionCacheTtlMs: number;
  /** Minimum number of latency samples before trusting average */
  minLatencySamples: number;
  /** Models to exclude from auto-routing */
  excludedModels: string[];
  /**
   * The model the client actually asked for (`provider/model`). A reroute stays
   * inside that provider whenever it can see — same credential, same quota, same
   * cost profile — instead of jumping to whichever namespace happens to sort first.
   */
  requestedModel?: string;
}

const DEFAULT_ROUTER_CONFIG: VisionBridgeRouterConfig = {
  maxFallbackAttempts: 3,
  selectionCacheTtlMs: 60_000, // 1 minute
  minLatencySamples: 5,
  excludedModels: [],
};

// In-memory latency tracker (would be Redis in production)
const latencyStore = new Map<string, LatencyRecord[]>();
const selectionCache = new Map<string, { modelId: string; expiresAt: number }>();

/**
 * Record a latency measurement for a model.
 */
export function recordLatency(modelId: string, latencyMs: number, success: boolean): void {
  const records = latencyStore.get(modelId) || [];
  records.push({
    modelId,
    latencyMs,
    timestamp: Date.now(),
    success,
  });

  // Keep only last 100 records per model
  if (records.length > 100) {
    records.splice(0, records.length - 100);
  }

  latencyStore.set(modelId, records);
}

/**
 * Calculate average latency for a model, considering only recent records.
 */
function calculateAverageLatency(modelId: string, windowMs: number = 300_000): number {
  const records = latencyStore.get(modelId) || [];
  const cutoff = Date.now() - windowMs;
  const recentRecords = records.filter((r) => r.timestamp > cutoff && r.success);

  if (recentRecords.length === 0) {
    return Infinity; // No data = assume slow
  }

  const sum = recentRecords.reduce((acc, r) => acc + r.latencyMs, 0);
  return sum / recentRecords.length;
}

/**
 * Calculate success rate for a model.
 */
function calculateSuccessRate(modelId: string): number {
  const records = latencyStore.get(modelId) || [];
  if (records.length === 0) return 1.0; // No data = assume good

  const recentRecords = records.slice(-50); // Last 50 attempts
  const successes = recentRecords.filter((r) => r.success).length;
  return successes / recentRecords.length;
}

/**
 * Providers that carry NO credential of their own: the `noAuth: true` catalog and
 * the API-key gateways that fall back to an anonymous upstream. Keyed by BOTH the
 * provider id and its public alias, because `PROVIDER_MODELS` is keyed by alias.
 *
 * These must never be a Vision Bridge reroute target. They have no connection row,
 * so a reroute lands on a shared anonymous endpoint that is rate-limited per egress
 * IP and can be blocked outright; and their synced catalogs overstate capability —
 * `visionBridgeDefaults.ts` already documents opencode-zen/opencode-go advertising
 * `image` input for backends with no native vision. Sending a user's image to an
 * anonymous third-party endpoint is also not a silent default worth having.
 */
const CREDENTIALLESS_PROVIDER_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const add = (id: string, alias?: unknown) => {
    keys.add(id);
    if (typeof alias === "string" && alias) keys.add(alias);
  };
  for (const [id, def] of Object.entries(
    NOAUTH_PROVIDERS as Record<string, { alias?: unknown } | undefined>
  )) {
    add(id, def?.alias);
  }
  for (const [id, def] of Object.entries(
    APIKEY_PROVIDERS_GATEWAYS as Record<
      string,
      { alias?: unknown; anonymousFallback?: unknown } | undefined
    >
  )) {
    if (def?.anonymousFallback === true) add(id, def?.alias);
  }
  return keys;
})();

function providerPrefixOf(modelId: string | null | undefined): string | null {
  if (!modelId || typeof modelId !== "string") return null;
  const i = modelId.indexOf("/");
  return i > 0 ? modelId.slice(0, i) : null;
}

/** Exported so the regression test asserts against the same source as the router. */
export function isCredentiallessProviderKey(providerKey: string | null | undefined): boolean {
  if (!providerKey) return false;
  return CREDENTIALLESS_PROVIDER_KEYS.has(providerKey);
}

/**
 * Get all vision-capable models from the registry.
 */
function getVisionCapableModels(): VisionModelCandidate[] {
  const candidates: VisionModelCandidate[] = [];

  for (const [providerAlias, models] of Object.entries(PROVIDER_MODELS)) {
    if (!Array.isArray(models)) continue;
    // A provider with no credential can never serve a reroute — skip the whole
    // namespace rather than ranking it. This is what made a missing vision flag
    // fatal instead of graceful: `opencode-*` used to be scored priority 0
    // ("local/free models first"), which is wrong twice over — those providers are
    // remote, not local, and being cheapest is worthless when the call cannot
    // authenticate. They outranked every real provider and won every selection.
    if (isCredentiallessProviderKey(providerAlias)) continue;

    for (const model of models) {
      if (!model?.id) continue;

      const fullModelId = `${providerAlias}/${model.id}`;
      const caps = getResolvedModelCapabilities(fullModelId);

      if (caps.supportsVision === true) {
        // Determine priority based on provider type
        const priority =
          providerAlias === "openai" || providerAlias === "anthropic"
            ? 50 // Major providers
            : 75; // Other providers

        candidates.push({
          modelId: model.id,
          fullName: fullModelId,
          priority,
          averageLatencyMs: calculateAverageLatency(fullModelId),
          lastUsedAt: 0,
          successRate: calculateSuccessRate(fullModelId),
        });
      }
    }
  }

  return candidates;
}

/**
 * Select the best vision model based on latency, priority, and success rate.
 */
function selectBestModel(
  candidates: VisionModelCandidate[],
  config: VisionBridgeRouterConfig
): VisionModelCandidate | null {
  const filtered = candidates.filter((c) => {
    // Exclude explicitly excluded models
    if (config.excludedModels.includes(c.fullName)) return false;
    if (config.excludedModels.includes(c.modelId)) return false;

    // Exclude models with poor success rate (< 50%)
    if (c.successRate < 0.5) return false;

    return true;
  });

  if (filtered.length === 0) return null;

  // Score each candidate: lower is better
  // Score = priority * 1000 + averageLatencyMs
  // This prioritizes local models, then fastest latency
  const scored = filtered.map((c) => ({
    ...c,
    score: c.priority * 1000 + (c.averageLatencyMs === Infinity ? 10000 : c.averageLatencyMs),
  }));

  // Keep the reroute inside the requested provider when that provider has a model
  // that can see. Latency is tracked in-process and is empty on a cold worker, so
  // every candidate in a tier scores identically and `sort` — being stable — used to
  // hand the win to whatever the registry happened to list first. That is how an
  // image for `gh/<blind model>` could be answered by a metered `anthropic/` model
  // while the same account already had a vision-capable sibling. Staying put keeps
  // the credential, the quota and the cost profile the caller chose.
  const requestedPrefix = providerPrefixOf(config.requestedModel);
  scored.sort((a, b) => {
    if (requestedPrefix) {
      const aSame = providerPrefixOf(a.fullName) === requestedPrefix ? 0 : 1;
      const bSame = providerPrefixOf(b.fullName) === requestedPrefix ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
    }
    return a.score - b.score;
  });

  return scored[0];
}

/**
 * Get the best vision model for image description.
 * Respects fixed model override if configured.
 */
export function getBestVisionModel(
  config: Partial<VisionBridgeRouterConfig> = {}
): string {
  const fullConfig = { ...DEFAULT_ROUTER_CONFIG, ...config };

  // If fixed model is configured, use it
  if (fullConfig.fixedModel) {
    return fullConfig.fixedModel;
  }

  // Check selection cache — key includes excluded models to prevent cache pollution
  // across different configurations
  // The requested provider is part of the key: without it a cached pick made for
  // one provider would be served to every other one, silently undoing the
  // same-provider preference.
  const requestedPrefix = providerPrefixOf(fullConfig.requestedModel);
  const cacheKey = [
    fullConfig.excludedModels.length > 0
      ? `excl:${[...fullConfig.excludedModels].sort().join(",")}`
      : "default",
    requestedPrefix ? `req:${requestedPrefix}` : "req:-",
  ].join("|");
  const cached = selectionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.modelId;
  }

  // Get all vision-capable candidates
  const candidates = getVisionCapableModels();

  // Select best model
  const best = selectBestModel(candidates, fullConfig);

  if (!best) {
    // Fallback to default
    return "openai/gpt-4o-mini";
  }

  // Cache the selection
  selectionCache.set(cacheKey, {
    modelId: best.fullName,
    expiresAt: Date.now() + fullConfig.selectionCacheTtlMs,
  });

  return best.fullName;
}

/**
 * Get fallback models for retry logic.
 */
export function getFallbackModels(
  excludeModel: string,
  config: Partial<VisionBridgeRouterConfig> = {}
): string[] {
  const fullConfig = { ...DEFAULT_ROUTER_CONFIG, ...config };
  const candidates = getVisionCapableModels();

  const filtered = candidates.filter(
    (c) =>
      c.fullName !== excludeModel &&
      !fullConfig.excludedModels.includes(c.fullName) &&
      c.successRate >= 0.5
  );

  // Sort by score
  const scored = filtered.map((c) => ({
    ...c,
    score: c.priority * 1000 + (c.averageLatencyMs === Infinity ? 10000 : c.averageLatencyMs),
  }));

  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, fullConfig.maxFallbackAttempts - 1).map((c) => c.fullName);
}

/**
 * Clear the selection cache (e.g., after config change).
 */
export function clearSelectionCache(): void {
  selectionCache.clear();
}

/**
 * Get latency statistics for debugging.
 */
export function getLatencyStats(): Record<string, { avg: number; samples: number; successRate: number }> {
  const stats: Record<string, { avg: number; samples: number; successRate: number }> = {};

  for (const [modelId, records] of latencyStore.entries()) {
    const recentRecords = records.filter((r) => r.timestamp > Date.now() - 300_000);
    if (recentRecords.length === 0) continue;

    const avg = recentRecords.reduce((acc, r) => acc + r.latencyMs, 0) / recentRecords.length;
    const successRate = recentRecords.filter((r) => r.success).length / recentRecords.length;

    stats[modelId] = {
      avg: Math.round(avg),
      samples: recentRecords.length,
      successRate: Math.round(successRate * 100) / 100,
    };
  }

  return stats;
}
