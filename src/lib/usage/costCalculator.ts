/**
 * Cost Calculator — extracted from usageDb.js (T-15)
 *
 * Pure function for calculating request cost based on model pricing.
 * No DB interaction — pricing is fetched from localDb.
 *
 * @module lib/usage/costCalculator
 */

import { isFlatRateProvider } from "./flatRateProviders";

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
  /**
   * Asserts that `tokens` belong to exactly ONE request, so the prompt size of that
   * request decides the long-context tier (`isLongContextPrompt`). Never set it on
   * token SUMS: a week of small requests adds up past the threshold and would be
   * billed at the long-context rate. Grouped callers instead pass the pre-split
   * `lc*` fields (see `LongContextTokens`) built from per-request SQL buckets.
   */
  requestScoped?: boolean;
};

/**
 * Prompt size above which a model with a `long_context` pricing block (Claude Haiku 5.5:
 * "prompts over 100,000 tokens") bills the WHOLE request — input, output, cache — at the
 * higher rates. Prompt size counts cache reads and writes, matching the extractors'
 * `prompt_tokens`. SQL buckets (`longContextSumColumns`) use the same constant.
 */
export const LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS = 100_000;

/**
 * Portion of a token record that came from requests over the threshold, in the same
 * vocabulary as the record's own totals (a subset of them, never an addition).
 * Absent or zero means "no long-context requests in this bucket", i.e. base pricing.
 */
export type LongContextTokens = {
  lcInput?: number;
  lcOutput?: number;
  lcCacheRead?: number;
  lcCacheCreation?: number;
  lcReasoning?: number;
};

/**
 * xAI reports the exact provider-billed cost of a request in the chat-completions
 * `usage` object via `cost_in_usd_ticks` (port of decolua/9router#2453, capability
 * A — @ryanngit). Per the official docs — both
 * https://docs.x.ai/developers/cost-tracking and the API reference's usage schema
 * ("TICKS_IN_USD_CENT: i64 = 100_000_000") — there are 10_000_000_000 (1e10) ticks
 * per USD. Example from the docs: 37756000 ticks ≈ $0.0038.
 *
 * NOTE: this divisor is intentionally 1e10, not the 1e12 used by the upstream PR
 * (which under-reports cost 100x) — verified directly against the xAI docs.
 */
const USD_TICKS_PER_DOLLAR = 10_000_000_000;

/**
 * Extract an exact, provider-reported USD cost from a token/usage record when one
 * is present, so callers can trust it over the token × pricing estimate. Currently
 * only xAI's `cost_in_usd_ticks` field is handled — see comment above.
 */
function extractExactCostUsd(
  tokens: Record<string, number | undefined> | null | undefined
): number | null {
  const ticks = tokens?.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0) {
    return ticks / USD_TICKS_PER_DOLLAR;
  }
  return null;
}

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
  return model.replace(/-(?:ultra|max|xhigh|high|medium|low|none)$/i, "");
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
  if (
    /^gpt-5\.6-(?:sol|terra|luna)$/.test(modelKey) ||
    /^gpt5\.6(?:sol|terra|luna)$/.test(compactModelKey)
  ) {
    return 1.5;
  }
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
type PriceSet = {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  cacheCreation: number;
};

type TokenSet = {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
};

function readPriceSet(pricing: Record<string, unknown>): PriceSet {
  const input = toNumber(pricing.input, 0);
  const output = toNumber(pricing.output, 0);
  return {
    input,
    cached: toNumber(pricing.cached, input),
    output,
    reasoning: toNumber(pricing.reasoning, output),
    cacheCreation: toNumber(pricing.cache_creation, input),
  };
}

/**
 * The model's long-context rates, or null when it has none. A malformed block (not an
 * object, or without an input/output rate) is ignored rather than guessed at: the
 * request then bills at base rates, the same as before the tier existed.
 */
function readLongContextPriceSet(pricing: Record<string, unknown>): PriceSet | null {
  const tier = pricing.long_context;
  if (!tier || typeof tier !== "object" || Array.isArray(tier)) return null;
  const record = tier as Record<string, unknown>;
  if (toNumber(record.input, -1) < 0 || toNumber(record.output, -1) < 0) return null;
  return readPriceSet(record);
}

function readTokenSet(tokens: Record<string, number | undefined>): TokenSet {
  return {
    input: tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    cacheRead: tokens.cacheRead ?? tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? 0,
    cacheCreation: tokens.cacheCreation ?? tokens.cache_creation_input_tokens ?? 0,
    output: tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0,
    reasoning: tokens.reasoning ?? tokens.reasoning_tokens ?? 0,
  };
}

/**
 * True when ONE request's prompt crosses the long-context threshold. `input` already
 * includes cache reads and writes (the extractors' `prompt_tokens`), so it is the
 * prompt size; do not add the cache fields on top.
 */
export function isLongContextPrompt(
  tokens: Record<string, number | undefined> | null | undefined
): boolean {
  if (!tokens) return false;
  return readTokenSet(tokens).input > LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS;
}

function priceTokenSet(prices: PriceSet, t: TokenSet): number {
  // prompt_tokens from extractors already includes cache_read + cache_creation,
  // so we must subtract BOTH cache types to avoid pricing cache at the full
  // input rate in addition to their dedicated cache_* rates below.
  const nonCachedInput = Math.max(0, t.input - t.cacheRead - t.cacheCreation);
  let cost = nonCachedInput * (prices.input / 1_000_000);
  if (t.cacheRead > 0) cost += t.cacheRead * (prices.cached / 1_000_000);
  cost += t.output * (prices.output / 1_000_000);
  if (t.reasoning > 0) cost += t.reasoning * (prices.reasoning / 1_000_000);
  if (t.cacheCreation > 0) cost += t.cacheCreation * (prices.cacheCreation / 1_000_000);
  return cost;
}

/**
 * Split `total` into the part that came from long-context requests and the rest.
 * Request-scoped records are all-or-nothing on their own prompt size; grouped records
 * carry the split computed per request in SQL. The long part is clamped to the total
 * so a bad bucket can never bill more tokens than were counted.
 */
function splitLongContext(
  tokens: Record<string, number | undefined>,
  total: TokenSet,
  requestScoped: boolean
): { base: TokenSet; long: TokenSet } {
  const zero: TokenSet = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0 };
  if (requestScoped) {
    return total.input > LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS
      ? { base: zero, long: total }
      : { base: total, long: zero };
  }
  const clamp = (value: number | undefined, max: number) =>
    Math.min(max, Math.max(0, toNumber(value, 0)));
  const long: TokenSet = {
    input: clamp(tokens.lcInput, total.input),
    cacheRead: clamp(tokens.lcCacheRead, total.cacheRead),
    cacheCreation: clamp(tokens.lcCacheCreation, total.cacheCreation),
    output: clamp(tokens.lcOutput, total.output),
    reasoning: clamp(tokens.lcReasoning, total.reasoning),
  };
  return {
    long,
    base: {
      input: total.input - long.input,
      cacheRead: total.cacheRead - long.cacheRead,
      cacheCreation: total.cacheCreation - long.cacheCreation,
      output: total.output - long.output,
      reasoning: total.reasoning - long.reasoning,
    },
  };
}

export function computeCostFromPricing(
  pricing: Record<string, unknown> | null | undefined,
  tokens: Record<string, number | undefined> | null | undefined,
  options: CostCalculationOptions = {}
): number {
  if (!tokens) return 0;
  // Trust an exact, provider-reported cost over the token × pricing estimate
  // when one is present — works even when no local pricing row exists yet.
  const exactCostUsd = extractExactCostUsd(tokens);
  if (exactCostUsd !== null) return exactCostUsd;
  if (!pricing) return 0;
  // Flat-rate (subscription / cookie-web) providers don't bill per token — their
  // per-token pricing rows exist only for estimation, so display surfaces opt in
  // to show $0 instead of an inflated estimate (#5552).
  if (options.flatRateAsZero && isFlatRateProvider(options.provider)) return 0;

  const total = readTokenSet(tokens);
  const longPrices = readLongContextPriceSet(pricing);

  let cost: number;
  if (longPrices) {
    const { base, long } = splitLongContext(tokens, total, options.requestScoped === true);
    cost = priceTokenSet(readPriceSet(pricing), base) + priceTokenSet(longPrices, long);
  } else {
    cost = priceTokenSet(readPriceSet(pricing), total);
  }

  return cost * getCodexFastCostMultiplier(options.provider, options.model, options.serviceTier);
}

export async function calculateCost(
  provider: string,
  model: string,
  tokens: Record<string, number | undefined> | null | undefined,
  options: CostCalculationOptions = {}
): Promise<number> {
  if (!tokens || !provider || !model) return 0;

  // Short-circuit before any pricing DB lookup when an exact, provider-reported
  // cost is present (currently xAI's `cost_in_usd_ticks` — see extractExactCostUsd).
  const exactCostUsd = extractExactCostUsd(tokens);
  if (exactCostUsd !== null) return exactCostUsd;

  try {
    const { getPricingForModel } = await import("@/lib/localDb");

    // Try exact match first, then normalized model name
    let pricing = await getPricingForModel(provider, model);
    if (!pricing) {
      const normalized = normalizeModelName(model);
      if (normalized !== model) {
        pricing = await getPricingForModel(provider, normalized);
      }
      const providerKey = normalizeServiceTier(provider);
      if (!pricing && (providerKey === "codex" || providerKey === "cx")) {
        const effortlessModel = stripCodexEffortSuffix(normalized);
        if (effortlessModel !== normalized) {
          pricing = await getPricingForModel(provider, effortlessModel);
        }
      }
    }
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

/**
 * `calculateCost` for the tokens of exactly ONE request (the usage its own response
 * reported). The prompt size of that request selects the long-context tier. Use this
 * everywhere a single request is priced as it completes; never for token sums — those
 * go through `calculateCost` with the `lc*` split from `longContextSumColumns`.
 */
export function calculateRequestCost(
  provider: string,
  model: string,
  tokens: Record<string, number | undefined> | null | undefined,
  options: CostCalculationOptions = {}
): Promise<number> {
  return calculateCost(provider, model, tokens, { ...options, requestScoped: true });
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
