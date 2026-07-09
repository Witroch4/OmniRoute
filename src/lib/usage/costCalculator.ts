/**
 * Cost Calculator — extracted from usageDb.js (T-15)
 *
 * Pure function for calculating request cost based on model pricing.
 * No DB interaction — pricing is fetched from localDb.
 *
 * @module lib/usage/costCalculator
 */

import { isFlatRateProvider } from "./flatRateProviders";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";

/**
 * Normalize model name — strip provider path prefixes.
 * Examples:
 *   "openai/gpt-oss-120b" → "gpt-oss-120b"
 *   "accounts/fireworks/models/gpt-oss-120b" → "gpt-oss-120b"
 *   "deepseek-ai/DeepSeek-R1" → "DeepSeek-R1"
 *   "gpt-oss-120b" → "gpt-oss-120b" (no-op)
 *
 */
export function normalizeModelName(model: string): string {
  if (!model || !model.includes("/")) return model;
  const parts = model.split("/");
  return parts[parts.length - 1];
}

export type CostCalculationOptions = {
  provider?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  /**
   * When true, return $0 for flat-rate (subscription / cookie-web) providers
   * instead of the per-token estimate (#5552). Opt-in so only analytics/display
   * surfaces zero out; budget / quota / routing keep estimating. Requires
   * `provider` to be set.
   */
  flatRateAsZero?: boolean;
};

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeServiceTier(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stripCodexEffortSuffix(model: string): string {
  return model.replace(/-(?:xhigh|high|medium|low|none)$/i, "");
}

type PricingRecord = Record<string, unknown>;
type PricingModels = Record<string, PricingRecord>;
type PricingByProvider = Record<string, PricingModels>;

function findKeyInsensitive<T>(
  obj: Record<string, T> | undefined | null,
  key: string
): T | undefined {
  if (!obj || !key) return undefined;
  const lowerKey = key.toLowerCase();
  for (const [candidate, value] of Object.entries(obj)) {
    if (candidate.toLowerCase() === lowerKey) return value;
  }
  return undefined;
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function getPricingModelCandidates(model: string, normalize: (model: string) => string): string[] {
  const normalizedModel = normalize(model);
  const lowerModel = model.toLowerCase();
  const lowerNormalized = normalizedModel.toLowerCase();
  const hyphenModel = lowerModel.replace(/\./g, "-");
  const hyphenNormalized = lowerNormalized.replace(/\./g, "-");
  const effortBaseModel = stripCodexEffortSuffix(lowerNormalized);

  return uniqueValues([
    lowerModel,
    lowerNormalized,
    hyphenModel,
    hyphenNormalized,
    effortBaseModel,
    effortBaseModel.replace(/\./g, "-"),
    lowerNormalized === "codex-auto-review" ? "gpt-5.5" : null,
  ]);
}

function resolveProviderPricing(
  pricingByProvider: PricingByProvider,
  providerAliasMap: Record<string, string>,
  providerRaw: string
): PricingModels | null {
  const providerKey = (providerRaw || "").toLowerCase();
  let providerPricing = findKeyInsensitive<PricingModels>(pricingByProvider, providerKey);

  if (!providerPricing) {
    const alias = findKeyInsensitive<string>(providerAliasMap, providerKey);
    if (alias) providerPricing = findKeyInsensitive<PricingModels>(pricingByProvider, alias);
  }

  if (!providerPricing) {
    for (const [id, alias] of Object.entries(providerAliasMap)) {
      if (typeof alias === "string" && alias.toLowerCase() === providerKey) {
        providerPricing = findKeyInsensitive<PricingModels>(pricingByProvider, id);
        if (providerPricing) break;
      }
    }
  }

  if (!providerPricing) {
    const withoutRegion = providerKey.replace(/-cn$/, "");
    if (withoutRegion && withoutRegion !== providerKey) {
      providerPricing = findKeyInsensitive<PricingModels>(pricingByProvider, withoutRegion);
    }
  }

  if (!providerPricing && providerKey === "antigravity") {
    providerPricing = findKeyInsensitive<PricingModels>(pricingByProvider, "ag");
  }

  return providerPricing || null;
}

function getClaudeModelFamily(model: string, normalize: (model: string) => string): string | null {
  const normalized = normalize(model).toLowerCase();
  const match = normalized.match(/^claude[-_](fable|opus|sonnet|haiku)(?:[-_]|$)/);
  return match?.[1] ?? null;
}

function findClaudeFamilyPricing(
  providerPricing: PricingModels | null | undefined,
  model: string,
  normalize: (model: string) => string
): PricingRecord | null {
  if (!providerPricing) return null;
  const family = getClaudeModelFamily(model, normalize);
  if (!family) return null;

  const prefix = `claude-${family}-`;
  const familyKeys = Object.keys(providerPricing)
    .filter((key) => normalize(key).toLowerCase().startsWith(prefix))
    .sort((left, right) => right.localeCompare(left));

  const selectedKey = familyKeys[0];
  return selectedKey ? providerPricing[selectedKey] || null : null;
}

export function resolveModelPricingFromCatalog(
  pricingByProvider: PricingByProvider,
  providerAliasMap: Record<string, string>,
  providerRaw: string,
  model: string,
  normalize: (model: string) => string = normalizeModelName
): PricingRecord | null {
  const providerPricing = resolveProviderPricing(pricingByProvider, providerAliasMap, providerRaw);
  const modelCandidates = getPricingModelCandidates(model, normalize);

  const tryFind = (models: PricingModels | null | undefined): PricingRecord | null => {
    if (!models) return null;
    for (const candidate of modelCandidates) {
      const pricing = findKeyInsensitive<PricingRecord>(models, candidate);
      if (pricing) return pricing;
    }
    return null;
  };

  let pricing = tryFind(providerPricing);
  if (!pricing) pricing = findClaudeFamilyPricing(providerPricing, model, normalize);

  if (!pricing) {
    for (const models of Object.values(pricingByProvider)) {
      const found = tryFind(models);
      if (found) {
        pricing = found;
        break;
      }
    }
  }

  if (!pricing) {
    for (const models of Object.values(pricingByProvider)) {
      const found = findClaudeFamilyPricing(models, model, normalize);
      if (found) {
        pricing = found;
        break;
      }
    }
  }

  if (!pricing && providerPricing) {
    const lowerModel = model.toLowerCase();
    for (const [key, value] of Object.entries(providerPricing)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes(lowerModel) || lowerModel.includes(lowerKey)) {
        pricing = value;
        break;
      }
    }
  }

  return pricing || null;
}

export function getCodexFastCostMultiplier(
  provider: string | null | undefined,
  model: string | null | undefined,
  serviceTier: string | null | undefined
): number {
  const providerKey = normalizeServiceTier(provider);
  const tier = normalizeServiceTier(serviceTier);
  if (providerKey !== "codex" && providerKey !== "cx") {
    return 1;
  }

  // OpenAI Flex Processing is billed at a 50% token discount, like Batch,
  // while still using the Responses API with service_tier="flex".
  if (tier === "flex") return 0.5;

  if (tier !== "priority" && tier !== "fast") return 1;

  const modelKey = stripCodexEffortSuffix(normalizeModelName(String(model || "")).toLowerCase());
  const compactModelKey = modelKey.replace(/-/g, "");
  if (modelKey === "gpt-5.5" || compactModelKey === "gpt5.5") return 2.5;
  if (modelKey === "gpt-5.4" || compactModelKey === "gpt5.4") return 2;
  return 1;
}

/**
 * Calculate cost for a usage entry.
 *
 * @param {string} provider
 * @param {string} model
 * @param {Object} tokens
 * @returns {Promise<number>} Cost in USD
 */
/**
 * Compute cost synchronously from a pre-fetched pricing record.
 * Use this when pricing has already been loaded (e.g. in batch analytics).
 */
export function computeCostFromPricing(
  pricing: Record<string, unknown> | null | undefined,
  tokens: Record<string, number | undefined> | null | undefined,
  options: CostCalculationOptions = {}
): number {
  if (!pricing || !tokens) return 0;
  // Flat-rate (subscription / cookie-web) providers don't bill per token — their
  // per-token pricing rows exist only for estimation, so display surfaces opt in
  // to show $0 instead of an inflated estimate (#5552).
  if (options.flatRateAsZero && isFlatRateProvider(options.provider)) return 0;
  const inputPrice = toNumber(pricing.input, 0);
  const cachedPrice = toNumber(pricing.cached, inputPrice);
  const outputPrice = toNumber(pricing.output, 0);
  const reasoningPrice = toNumber(pricing.reasoning, outputPrice);
  const cacheCreationPrice = toNumber(pricing.cache_creation, inputPrice);

  let cost = 0;
  const inputTokens = tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
  const cachedTokens =
    tokens.cacheRead ?? tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = tokens.cacheCreation ?? tokens.cache_creation_input_tokens ?? 0;

  // prompt_tokens from extractors already includes cache_read + cache_creation,
  // so we must subtract BOTH cache types to avoid pricing cache at the full
  // input rate in addition to their dedicated cache_* rates below.
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
  cost += nonCachedInput * (inputPrice / 1_000_000);
  if (cachedTokens > 0) cost += cachedTokens * (cachedPrice / 1_000_000);

  const outputTokens = tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
  cost += outputTokens * (outputPrice / 1_000_000);

  const reasoningTokens = tokens.reasoning ?? tokens.reasoning_tokens ?? 0;
  if (reasoningTokens > 0) cost += reasoningTokens * (reasoningPrice / 1_000_000);

  if (cacheCreationTokens > 0) cost += cacheCreationTokens * (cacheCreationPrice / 1_000_000);

  return cost * getCodexFastCostMultiplier(options.provider, options.model, options.serviceTier);
}

export async function calculateCost(
  provider: string,
  model: string,
  tokens: Record<string, number | undefined> | null | undefined,
  options: CostCalculationOptions = {}
): Promise<number> {
  if (!tokens || !provider || !model) return 0;

  try {
    const { getPricing } = await import("@/lib/localDb");
    const pricingByProvider = (await getPricing()) as PricingByProvider;
    const pricing = resolveModelPricingFromCatalog(
      pricingByProvider,
      PROVIDER_ID_TO_ALIAS,
      provider,
      model
    );
    if (!pricing) return 0;

    const pricingRecord =
      pricing && typeof pricing === "object" && !Array.isArray(pricing)
        ? (pricing as Record<string, unknown>)
        : {};
    return computeCostFromPricing(pricingRecord, tokens, {
      provider,
      model,
      ...options,
    });
  } catch (error) {
    console.error("Error calculating cost:", error);
    return 0;
  }
}

type ModalPricing = Record<string, unknown>;

/** Per-image cost: flat per-image × n. 0 when pricing/usage absent. */
export function computeImageCost(
  pricing: ModalPricing | null | undefined,
  usage: { n?: number }
): number {
  if (!pricing) return 0;
  const perImage = toNumber(pricing.output_cost_per_image ?? pricing.input_cost_per_image, 0);
  const n = Math.max(0, Math.floor(toNumber(usage.n, 0)));
  return perImage * n;
}

/** Audio cost: per-second (transcription) OR per-character (TTS). 0 when no dimension. */
export function computeAudioCost(
  pricing: ModalPricing | null | undefined,
  usage: { seconds?: number; characters?: number }
): number {
  if (!pricing) return 0;
  const seconds = toNumber(usage.seconds, 0);
  if (seconds > 0) {
    const perSecond = toNumber(pricing.input_cost_per_second ?? pricing.output_cost_per_second, 0);
    if (perSecond > 0) return perSecond * seconds;
  }
  const characters = toNumber(usage.characters, 0);
  if (characters > 0) {
    const perChar = toNumber(
      pricing.input_cost_per_character ?? pricing.output_cost_per_character,
      0
    );
    // Round to 10 decimals to drop binary-FP artifacts (e.g. 0.000015 * 1000).
    if (perChar > 0) return Math.round(perChar * characters * 1e10) / 1e10;
  }
  return 0;
}

/** Rerank cost: per search unit (Cohere-style billed_units.search_units). */
export function computeRerankCost(
  pricing: ModalPricing | null | undefined,
  usage: { searchUnits?: number }
): number {
  if (!pricing) return 0;
  const perUnit = toNumber(pricing.search_unit_cost ?? pricing.input_cost_per_query, 0);
  const units = Math.max(0, toNumber(usage.searchUnits, 0));
  return perUnit * units;
}

/** Video cost: per video-second. */
export function computeVideoCost(
  pricing: ModalPricing | null | undefined,
  usage: { seconds?: number }
): number {
  if (!pricing) return 0;
  const perSecond = toNumber(
    pricing.output_cost_per_video_per_second ?? pricing.input_cost_per_video_per_second,
    0
  );
  const seconds = toNumber(usage.seconds, 0);
  return perSecond * seconds;
}

export type Modality = "image" | "audio" | "rerank" | "video";
export type ModalUsage = {
  n?: number;
  seconds?: number;
  characters?: number;
  searchUnits?: number;
};

/**
 * Load pricing for (provider, model) and dispatch to the per-modality cost
 * function. Like `calculateCost` for tokens: returns 0 (never throws) when
 * pricing is missing.
 */
export async function calculateModalCost(
  modality: Modality,
  provider: string,
  model: string,
  usage: ModalUsage
): Promise<number> {
  if (!provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("@/lib/localDb");
    let pricing = await getPricingForModel(provider, model);
    if (!pricing) {
      const normalized = normalizeModelName(model);
      if (normalized !== model) pricing = await getPricingForModel(provider, normalized);
    }
    if (!pricing) return 0;
    const rec = pricing as Record<string, unknown>;
    switch (modality) {
      case "image":
        return computeImageCost(rec, usage);
      case "audio":
        return computeAudioCost(rec, usage);
      case "rerank":
        return computeRerankCost(rec, usage);
      case "video":
        return computeVideoCost(rec, usage);
      default:
        return 0;
    }
  } catch (error) {
    console.error("Error calculating modal cost:", error);
    return 0;
  }
}
