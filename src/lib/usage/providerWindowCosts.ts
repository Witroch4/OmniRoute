import { getCostSummary } from "@/domain/costRules";
import { getApiKeys } from "@/lib/db/apiKeys";
import { getDbInstance } from "@/lib/db/core";
import { getAllProviderLimitsCache, getProviderLimitsCache } from "@/lib/db/providerLimits";
import { calculateCost } from "@/lib/usage/costCalculator";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

interface CostRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  provider: string;
  model: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  lastUsed: string | null;
}

export interface ProviderWindowCostBreakdownRow {
  apiKeyKey: string;
  apiKeyId: string | null;
  apiKeyName: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  limitUsd: number | null;
  limitPeriod: string | null;
  limitUsedPercent: number | null;
  budgetResetAt: string | null;
  lastUsed: string | null;
  models: Array<{
    model: string;
    provider: string;
    serviceTier: string;
    requests: number;
    totalTokens: number;
    costUsd: number;
  }>;
}

export interface ProviderWindowCostBreakdown {
  provider: string;
  connectionId: string | null;
  windowStartAt: string;
  windowResetAt: string | null;
  windowSource: "provider_weekly_reset" | "fallback_rolling_7d";
  quotaName: string | null;
  quotaUsedPercent: number | null;
  quotaRemainingPercent: number | null;
  totalCostUsd: number;
  estimatedFullQuotaUsd: number | null;
  rows: ProviderWindowCostBreakdownRow[];
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseResetAt(value: unknown, nowMs: number): number | null {
  const resetAt = toString(value);
  if (!resetAt) return null;
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
  return parsed;
}

function getRemainingPercent(quota: JsonRecord): number | null {
  const explicit = toNumber(quota.remainingPercentage, Number.NaN);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));

  const total = toNumber(quota.total, 0);
  if (total <= 0) return null;
  const remaining = toNumber(quota.remaining, Number.NaN);
  if (Number.isFinite(remaining)) {
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }

  const used = toNumber(quota.used, Number.NaN);
  if (Number.isFinite(used)) {
    return Math.max(0, Math.min(100, ((total - used) / total) * 100));
  }

  return null;
}

function scoreWeeklyQuota(name: string): number {
  const normalized = name.trim().toLowerCase();
  if (!normalized.includes("weekly") && !normalized.includes("7d")) return Number.NEGATIVE_INFINITY;

  let score = 10;
  if (normalized === "weekly" || /^weekly\s*\(/.test(normalized)) score += 100;
  if (normalized.includes("7d") || normalized.includes("7 day")) score += 15;
  if (normalized.includes("sonnet")) score -= 30;
  if (/^(gpt|claude|o\d|gemini|opus|sonnet)\b/.test(normalized)) score -= 20;
  return score;
}

function selectWeeklyWindow(
  provider: string,
  connectionId: string | null,
  nowMs: number
): {
  startMs: number;
  resetMs: number | null;
  source: ProviderWindowCostBreakdown["windowSource"];
  quotaName: string | null;
  quotaUsedPercent: number | null;
  quotaRemainingPercent: number | null;
} {
  const cacheEntries = connectionId
    ? [[connectionId, getProviderLimitsCache(connectionId)] as const]
    : Object.entries(getAllProviderLimitsCache());

  let selected: {
    score: number;
    resetMs: number;
    quotaName: string;
    quotaUsedPercent: number | null;
    quotaRemainingPercent: number | null;
  } | null = null;

  for (const [, cache] of cacheEntries) {
    const quotas = toRecord(cache?.quotas);
    for (const [name, rawQuota] of Object.entries(quotas)) {
      const score = scoreWeeklyQuota(name);
      if (!Number.isFinite(score)) continue;
      const quota = toRecord(rawQuota);
      const resetMs = parseResetAt(quota.resetAt, nowMs);
      if (resetMs === null) continue;
      const remainingPercent = getRemainingPercent(quota);
      const usedPercent =
        remainingPercent === null ? null : Math.max(0, Math.min(100, 100 - remainingPercent));
      if (
        !selected ||
        score > selected.score ||
        (score === selected.score && resetMs < selected.resetMs)
      ) {
        selected = {
          score,
          resetMs,
          quotaName: name,
          quotaUsedPercent: usedPercent,
          quotaRemainingPercent: remainingPercent,
        };
      }
    }
  }

  if (selected) {
    return {
      startMs: selected.resetMs - WEEK_MS,
      resetMs: selected.resetMs,
      source: "provider_weekly_reset",
      quotaName: selected.quotaName,
      quotaUsedPercent: selected.quotaUsedPercent,
      quotaRemainingPercent: selected.quotaRemainingPercent,
    };
  }

  return {
    startMs: nowMs - WEEK_MS,
    resetMs: null,
    source: "fallback_rolling_7d",
    quotaName: null,
    quotaUsedPercent: null,
    quotaRemainingPercent: null,
  };
}

function makeApiKeyKey(apiKeyId: string | null, apiKeyName: string | null): string {
  if (apiKeyId) return `id:${apiKeyId}`;
  if (apiKeyName) return `name:${apiKeyName}`;
  return "unattributed";
}

async function getCurrentApiKeyNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const apiKeys = await getApiKeys();
    for (const apiKey of apiKeys) {
      if (typeof apiKey.id === "string" && typeof apiKey.name === "string") {
        names.set(apiKey.id, apiKey.name);
      }
    }
  } catch {
    // Usage rows carry historical names, so current API key names are an enhancement only.
  }
  return names;
}

export async function getProviderWindowCostBreakdown({
  provider,
  connectionId = null,
  now = Date.now(),
}: {
  provider: string;
  connectionId?: string | null;
  now?: number;
}): Promise<ProviderWindowCostBreakdown> {
  const providerKey = provider.trim().toLowerCase();
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const window = selectWeeklyWindow(providerKey, connectionId, nowMs);
  const windowStartAt = new Date(window.startMs).toISOString();
  const windowResetAt = window.resetMs ? new Date(window.resetMs).toISOString() : null;

  const where = ["LOWER(provider) = @provider", "timestamp >= @since"];
  const params: Record<string, string> = {
    provider: providerKey,
    since: windowStartAt,
  };
  if (windowResetAt) {
    where.push("timestamp < @resetAt");
    params.resetAt = windowResetAt;
  }
  if (connectionId) {
    where.push("connection_id = @connectionId");
    params.connectionId = connectionId;
  }

  const rows = getDbInstance()
    .prepare<CostRow>(
      `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        NULLIF(api_key_name, '') as apiKeyName,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        MAX(timestamp) as lastUsed
      FROM usage_history
      WHERE ${where.join(" AND ")}
      GROUP BY
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unattributed'),
        NULLIF(api_key_id, ''),
        NULLIF(api_key_name, ''),
        LOWER(provider),
        LOWER(model),
        serviceTier
      `
    )
    .all(params);

  const currentApiKeyNames = await getCurrentApiKeyNames();
  const byApiKey = new Map<string, ProviderWindowCostBreakdownRow>();

  for (const row of rows) {
    const apiKeyId = row.apiKeyId || null;
    const apiKeyName = row.apiKeyName || null;
    const apiKeyKey = makeApiKeyKey(apiKeyId, apiKeyName);
    const displayName =
      (apiKeyId ? currentApiKeyNames.get(apiKeyId) : null) ||
      apiKeyName ||
      apiKeyId ||
      "Unattributed";
    const costUsd = roundUsd(
      await calculateCost(
        row.provider,
        row.model,
        {
          input: toNumber(row.promptTokens),
          output: toNumber(row.completionTokens),
          cacheRead: toNumber(row.cacheReadTokens),
          cacheCreation: toNumber(row.cacheCreationTokens),
          reasoning: toNumber(row.reasoningTokens),
        },
        { serviceTier: row.serviceTier }
      )
    );

    let aggregate = byApiKey.get(apiKeyKey);
    if (!aggregate) {
      let limitUsd: number | null = null;
      let limitPeriod: string | null = null;
      let budgetResetAt: string | null = null;
      if (apiKeyId) {
        const summary = getCostSummary(apiKeyId);
        if (summary.activeLimitUsd > 0) {
          limitUsd = summary.activeLimitUsd;
          limitPeriod = summary.resetInterval;
          budgetResetAt =
            typeof summary.nextResetAt === "number" && Number.isFinite(summary.nextResetAt)
              ? new Date(summary.nextResetAt).toISOString()
              : null;
        }
      }
      aggregate = {
        apiKeyKey,
        apiKeyId,
        apiKeyName: displayName,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        limitUsd,
        limitPeriod,
        limitUsedPercent: null,
        budgetResetAt,
        lastUsed: null,
        models: [],
      };
      byApiKey.set(apiKeyKey, aggregate);
    }

    aggregate.requests += toNumber(row.requests);
    aggregate.promptTokens += toNumber(row.promptTokens);
    aggregate.completionTokens += toNumber(row.completionTokens);
    aggregate.totalTokens += toNumber(row.totalTokens);
    aggregate.costUsd = roundUsd(aggregate.costUsd + costUsd);
    if (!aggregate.lastUsed || (row.lastUsed && row.lastUsed > aggregate.lastUsed)) {
      aggregate.lastUsed = row.lastUsed || aggregate.lastUsed;
    }
    aggregate.models.push({
      model: row.model,
      provider: row.provider,
      serviceTier: row.serviceTier,
      requests: toNumber(row.requests),
      totalTokens: toNumber(row.totalTokens),
      costUsd,
    });
  }

  const breakdownRows = Array.from(byApiKey.values())
    .map((row) => {
      const limitUsedPercent =
        row.limitUsd && row.limitUsd > 0 ? roundPercent((row.costUsd / row.limitUsd) * 100) : null;
      return {
        ...row,
        costUsd: roundUsd(row.costUsd),
        limitUsedPercent,
        models: row.models
          .map((model) => ({ ...model, costUsd: roundUsd(model.costUsd) }))
          .sort((left, right) => right.costUsd - left.costUsd),
      };
    })
    .sort((left, right) => right.costUsd - left.costUsd);

  const totalCostUsd = roundUsd(breakdownRows.reduce((sum, row) => sum + row.costUsd, 0));
  const estimatedFullQuotaUsd =
    window.quotaUsedPercent && window.quotaUsedPercent > 0
      ? roundUsd(totalCostUsd / (window.quotaUsedPercent / 100))
      : null;

  return {
    provider: providerKey,
    connectionId,
    windowStartAt,
    windowResetAt,
    windowSource: window.source,
    quotaName: window.quotaName,
    quotaUsedPercent:
      window.quotaUsedPercent === null ? null : roundPercent(window.quotaUsedPercent),
    quotaRemainingPercent:
      window.quotaRemainingPercent === null ? null : roundPercent(window.quotaRemainingPercent),
    totalCostUsd,
    estimatedFullQuotaUsd,
    rows: breakdownRows,
  };
}
