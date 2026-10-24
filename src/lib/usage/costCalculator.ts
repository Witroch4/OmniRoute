/**
 * Cost Calculator — extracted from usageDb.js (T-15)
 *
 * Pure function for calculating request cost based on model pricing.
 * No DB interaction — pricing is fetched from localDb.
 *
 * @module lib/usage/costCalculator
 */

import { toNumber } from "@/shared/utils/numeric";
import { splitCodexReasoningSuffix } from "@omniroute/open-sse/executors/codex/reasoningSuffix.ts";
import { isCreditMeteredProvider } from "./creditMeteredProviders";
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
export type LongContextSplit = {
  lcInput?: number;
  lcOutput?: number;
  lcCacheRead?: number;
  lcCacheCreation?: number;
  lcReasoning?: number;
};

/**
 * The top-level `lc*` fields are the split at the default threshold
 * (`LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS`, exclusive). Rows whose `long_context` block
 * declares another threshold (upstream #12494: OpenAI >272K, xAI >=200K) read their
 * split from `lcTiers[longContextTierKey(...)]`. A grouped record without the split for
 * the row's threshold bills at base rates — never at a tier decided on the sums.
 */
export type LongContextTokens = LongContextSplit & {
  lcTiers?: Record<string, LongContextSplit>;
};

export type LongContextThreshold = { threshold: number; inclusive: boolean };

/** Key of a threshold in `LongContextTokens.lcTiers` (e.g. `272000`, `200000i`). */
export function longContextTierKey(tier: LongContextThreshold): string {
  return `${tier.threshold}${tier.inclusive ? "i" : ""}`;
}

/**
 * Thresholds the grouped SQL queries split per request (`longContextSql.ts`). The first
 * is the default (fork rows without an explicit threshold) and keeps the legacy `lc*`
 * column names; the others match the default catalog's explicit tiers. A custom
 * threshold outside this list is priced per request (`requestScoped`) only.
 */
export const LONG_CONTEXT_SQL_THRESHOLDS: readonly LongContextThreshold[] = [
  { threshold: LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS, inclusive: false },
  { threshold: 200_000, inclusive: true },
  { threshold: 272_000, inclusive: false },
];

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

type CostTokenDetails = {
  cached_tokens?: number;
  cache_creation_tokens?: number;
  cache_write_tokens?: number;
  cache_creation_in_prompt?: boolean;
  reasoning_tokens?: number;
};

/** Numeric aliases and nested details accepted from normalized or raw usage. */
interface CostTokenUsage extends Record<string, unknown>, LongContextSplit {
  lcTiers?: Record<string, LongContextSplit>;
  input?: number;
  prompt_tokens?: number;
  input_tokens?: number;
  cacheRead?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cacheCreation?: number;
  cache_creation_input_tokens?: number;
  output?: number;
  completion_tokens?: number;
  output_tokens?: number;
  reasoning?: number;
  reasoning_tokens?: number;
  cost_in_usd_ticks?: number;
  prompt_tokens_details?: CostTokenDetails;
  input_tokens_details?: CostTokenDetails;
  completion_tokens_details?: CostTokenDetails;
  output_tokens_details?: CostTokenDetails;
}

/**
 * Extract an exact, provider-reported USD cost from a token/usage record when one
 * is present, so callers can trust it over the token × pricing estimate. Handles
 * xAI's `cost_in_usd_ticks` (see comment above) first, then the normalized
 * `cost_usd` carried from OpenRouter's `usage.cost` (bare USD number).
 */
function extractExactCostUsd(tokens: CostTokenUsage | null | undefined): number | null {
  const ticks = tokens?.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0) {
    return ticks / USD_TICKS_PER_DOLLAR;
  }
  const costUsd = tokens?.cost_usd;
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
    return costUsd;
  }
  return null;
}

function normalizeServiceTier(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stripCodexEffortSuffix(model: string): string {
  return model.replace(/-(?:ultra|max|xhigh|high|medium|low|none)$/i, "");
}

/**
 * Effort-free pricing keys for a Codex model id, most specific first. The Codex
 * executor also accepts a parenthesized override (`gpt-6-luna(max)`), which the
 * pricing tables only list in its hyphen form (`gpt-6-luna-max`), so try that tier
 * key before the bare base model.
 */
function getCodexEffortlessPricingKeys(model: string): string[] {
  const lowered = model.toLowerCase();
  const { baseModel, effort } = splitCodexReasoningSuffix(lowered);
  if (effort && lowered === `${baseModel}(${effort})`) {
    return [`${baseModel}-${effort}`, baseModel];
  }
  const stripped = stripCodexEffortSuffix(model);
  return stripped !== model ? [stripped] : [];
}

function isCodexProvider(provider: string | null | undefined): boolean {
  const providerKey = normalizeServiceTier(provider);
  return providerKey === "codex" || providerKey === "cx";
}

/**
 * Model ids to look up, in order, when pricing (provider, model): exact id first (so
 * a user override on an annotated id wins), then the prefix-free id, then — for
 * Codex — the id with its reasoning-effort suffix removed. Exported so the
 * `/v1/models` catalog prices entries with the same fallbacks as cost accounting.
 */
export function getPricingLookupModels(provider: string, model: string): string[] {
  const keys = [model];
  const normalized = normalizeModelName(model);
  if (normalized !== model) keys.push(normalized);
  if (isCodexProvider(provider)) keys.push(...getCodexEffortlessPricingKeys(normalized));
  return keys;
}

/** Pricing row for (provider, model), trying {@link getPricingLookupModels} in order. */
async function resolvePricingRow(provider: string, model: string) {
  const { getPricingForModel } = await import("@/lib/db/settings");
  for (const key of getPricingLookupModels(provider, model)) {
    const pricing = await getPricingForModel(provider, key);
    if (pricing) return pricing;
  }
  return null;
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

  const modelKey = stripCodexEffortSuffix(
    splitCodexReasoningSuffix(normalizeModelName(String(model || "")).toLowerCase()).baseModel
  );
  const compactModelKey = modelKey.replace(/-/g, "");
  // Codex GPT-6 Fast is 2.5x Standard (https://developers.openai.com/codex/pricing).
  if (
    /^gpt-6(?:\.1)?-(?:astra|sol|luna)$/.test(modelKey) ||
    /^gpt6(?:\.1)?(?:astra|sol|luna)$/.test(compactModelKey)
  ) {
    return 2.5;
  }
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

type LongContextTier = LongContextThreshold & { prices: PriceSet };

/**
 * The model's long-context tier, or null when it has none. Two shapes are accepted:
 *
 * - With an explicit `threshold` (upstream #12494, e.g. OpenAI >272K, xAI >=200K with
 *   `inclusive`): rates the tier omits keep their FLAT value. A non-positive or
 *   non-numeric threshold makes the block malformed.
 * - Without a threshold (fork rows, Claude Haiku 5.5): the published 100K threshold
 *   (`LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS`, exclusive) applies, the block must carry
 *   both an input and an output rate, and the rates it omits fall back to its own
 *   input/output rates.
 *
 * A malformed block is ignored rather than guessed at: the request then bills at base
 * rates, the same as before the tier existed.
 */
function readLongContextTier(pricing: Record<string, unknown>): LongContextTier | null {
  const tier = pricing.long_context;
  if (!tier || typeof tier !== "object" || Array.isArray(tier)) return null;
  const record = tier as Record<string, unknown>;
  if (record.threshold !== undefined && record.threshold !== null) {
    const limit = toNumber(record.threshold, Number.NaN);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const { threshold: _threshold, inclusive, ...tierRates } = record;
    return {
      threshold: limit,
      inclusive: inclusive === true,
      prices: readPriceSet({ ...pricing, ...tierRates }),
    };
  }
  if (toNumber(record.input, -1) < 0 || toNumber(record.output, -1) < 0) return null;
  return {
    threshold: LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS,
    inclusive: false,
    prices: readPriceSet(record),
  };
}

function readTokenSet(tokens: CostTokenUsage): TokenSet {
  const promptDetails = tokens.prompt_tokens_details;
  const inputDetails = tokens.input_tokens_details;
  return {
    input: tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    cacheRead:
      tokens.cacheRead ??
      tokens.cached_tokens ??
      tokens.cache_read_input_tokens ??
      promptDetails?.cached_tokens ??
      inputDetails?.cached_tokens ??
      0,
    cacheCreation:
      tokens.cacheCreation ??
      tokens.cache_creation_input_tokens ??
      promptDetails?.cache_creation_tokens ??
      inputDetails?.cache_creation_tokens ??
      promptDetails?.cache_write_tokens ??
      inputDetails?.cache_write_tokens ??
      0,
    output: tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0,
    reasoning:
      tokens.reasoning ??
      tokens.reasoning_tokens ??
      tokens.completion_tokens_details?.reasoning_tokens ??
      tokens.output_tokens_details?.reasoning_tokens ??
      0,
  };
}

function crossesThreshold(promptTokens: number, tier: LongContextThreshold): boolean {
  return tier.inclusive ? promptTokens >= tier.threshold : promptTokens > tier.threshold;
}

/**
 * True when ONE request's prompt crosses the default long-context threshold. `input`
 * already includes cache reads and writes (the extractors' `prompt_tokens`), so it is
 * the prompt size; do not add the cache fields on top.
 */
export function isLongContextPrompt(tokens: CostTokenUsage | null | undefined): boolean {
  if (!tokens) return false;
  return readTokenSet(tokens).input > LONG_CONTEXT_PROMPT_THRESHOLD_TOKENS;
}

function priceTokenSet(prices: PriceSet, t: TokenSet, cacheCreationInPrompt: boolean): number {
  // prompt_tokens from extractors already includes cache_read + cache_creation,
  // so we must subtract BOTH cache types to avoid pricing cache at the full
  // input rate in addition to their dedicated cache_* rates below.
  // Translated usage can explicitly keep cache creation outside that total.
  const includedCacheCreation = cacheCreationInPrompt ? t.cacheCreation : 0;
  const nonCachedInput = Math.max(0, t.input - t.cacheRead - includedCacheCreation);
  let cost = nonCachedInput * (prices.input / 1_000_000);
  if (t.cacheRead > 0) cost += t.cacheRead * (prices.cached / 1_000_000);
  cost += t.output * (prices.output / 1_000_000);
  // completion_tokens is reasoning-inclusive. Reasoning is already billed at
  // the output rate above, so a dedicated price contributes only its premium
  // (a row without a reasoning rate defaults it to the output rate: no premium).
  if (t.reasoning > t.output) {
    // Reasoning exceeding completion is impossible when completion is inclusive,
    // so the provider reports separate buckets (#15496): bill reasoning on top.
    cost += t.reasoning * (prices.reasoning / 1_000_000);
  } else if (t.reasoning > 0) {
    cost += t.reasoning * ((prices.reasoning - prices.output) / 1_000_000);
  }
  cost = Math.max(0, cost);
  if (t.cacheCreation > 0) cost += t.cacheCreation * (prices.cacheCreation / 1_000_000);
  return cost;
}

/** The pre-split long part of a grouped record for this tier's threshold, if carried. */
function groupedLongSplit(
  tokens: CostTokenUsage,
  tier: LongContextThreshold
): LongContextSplit | null {
  const key = longContextTierKey(tier);
  if (key === longContextTierKey(LONG_CONTEXT_SQL_THRESHOLDS[0])) return tokens;
  const split = tokens.lcTiers?.[key];
  return split && typeof split === "object" ? split : null;
}

/**
 * Split `total` into the part that came from long-context requests and the rest.
 * Request-scoped records are all-or-nothing on their own prompt size; grouped records
 * carry the split computed per request in SQL. The long part is clamped to the total
 * so a bad bucket can never bill more tokens than were counted.
 */
function splitLongContext(
  tokens: CostTokenUsage,
  total: TokenSet,
  tier: LongContextThreshold,
  requestScoped: boolean
): { base: TokenSet; long: TokenSet } {
  const zero: TokenSet = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0 };
  if (requestScoped) {
    return crossesThreshold(total.input, tier)
      ? { base: zero, long: total }
      : { base: total, long: zero };
  }
  const split = groupedLongSplit(tokens, tier);
  if (!split) return { base: total, long: zero };
  const clamp = (value: unknown, max: number) => Math.min(max, Math.max(0, toNumber(value, 0)));
  const long: TokenSet = {
    input: clamp(split.lcInput, total.input),
    cacheRead: clamp(split.lcCacheRead, total.cacheRead),
    cacheCreation: clamp(split.lcCacheCreation, total.cacheCreation),
    output: clamp(split.lcOutput, total.output),
    reasoning: clamp(split.lcReasoning, total.reasoning),
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

/**
 * Compute cost synchronously from a pre-fetched pricing record.
 * Use this when pricing has already been loaded (e.g. in batch analytics).
 *
 * The long-context tier is decided per REQUEST: pass `requestScoped: true` for the
 * usage of one request, or the per-request `lc*` split (`longContextSql.ts`) with
 * grouped sums. Grouped sums without the split bill at base rates.
 */
export function computeCostFromPricing(
  pricing: Record<string, unknown> | null | undefined,
  tokens: CostTokenUsage | null | undefined,
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
  // A credit-metered provider bills in credits, reported per request as the exact
  // cost handled above. Its per-token rows describe no real tariff, so they are
  // never a cost basis: pricing them would bill the request a second time.
  if (isCreditMeteredProvider(options.provider)) return 0;

  const total = readTokenSet(tokens);
  const cacheCreationInPrompt =
    (tokens.input_tokens_details?.cache_creation_in_prompt ??
      tokens.prompt_tokens_details?.cache_creation_in_prompt) !== false;
  const basePrices = readPriceSet(pricing);
  const tier = readLongContextTier(pricing);

  let cost: number;
  if (tier) {
    const { base, long } = splitLongContext(tokens, total, tier, options.requestScoped === true);
    cost =
      priceTokenSet(basePrices, base, cacheCreationInPrompt) +
      priceTokenSet(tier.prices, long, cacheCreationInPrompt);
  } else {
    cost = priceTokenSet(basePrices, total, cacheCreationInPrompt);
  }

  return cost * getCodexFastCostMultiplier(options.provider, options.model, options.serviceTier);
}

/**
 * Result of a cost calculation that also reports whether the number is backed by
 * a real pricing row. Budget-enforcement callers (#12341) must be able to tell
 * "$0, priced" (a genuinely free/flat-rate model) apart from "$0, unpriced" (no
 * pricing row was ever found — e.g. a routing alias like `auto`) so they can fail
 * closed on the latter instead of letting it silently pass a hard budget cap.
 */
export interface CostCalculationResult {
  costUsd: number;
  /** false when no pricing row (direct, normalized, or codex-effortless) was found. */
  priced: boolean;
  /** A lookup error is not evidence that the model lacks a price. */
  failed?: boolean;
}

export async function calculateCostDetailed(
  provider: string,
  model: string,
  tokens: CostTokenUsage | null | undefined,
  options: CostCalculationOptions = {}
): Promise<CostCalculationResult> {
  if (!tokens || !provider || !model) return { costUsd: 0, priced: true };

  // Short-circuit before any pricing DB lookup when an exact, provider-reported
  // cost is present (xAI ticks or OpenRouter's USD cost — see extractExactCostUsd).
  const exactCostUsd = extractExactCostUsd(tokens);
  if (exactCostUsd !== null) return { costUsd: exactCostUsd, priced: true };

  try {
    const pricing = await resolvePricingRow(provider, model);
    // No pricing row anywhere — this is the #12341 case (e.g. a provider's own
    // routing alias such as "auto" that has no catalog price). Report it as
    // unpriced rather than a bare $0 so budget enforcement can fail closed.
    if (!pricing) return { costUsd: 0, priced: false };

    const pricingRecord =
      pricing && typeof pricing === "object" && !Array.isArray(pricing)
        ? (pricing as Record<string, unknown>)
        : {};
    const costUsd = computeCostFromPricing(pricingRecord, tokens, {
      provider,
      model,
      ...options,
    });
    return { costUsd, priced: true };
  } catch (error) {
    console.error("Error calculating cost:", error);
    return { costUsd: 0, priced: false, failed: true };
  }
}

export async function calculateCost(
  provider: string,
  model: string,
  tokens: CostTokenUsage | null | undefined,
  options: CostCalculationOptions = {}
): Promise<number> {
  const result = await calculateCostDetailed(provider, model, tokens, options);
  return result.costUsd;
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
  tokens: CostTokenUsage | null | undefined,
  options: CostCalculationOptions = {}
): Promise<number> {
  return calculateCost(provider, model, tokens, { ...options, requestScoped: true });
}

/** `calculateCostDetailed` for the tokens of exactly ONE request (see `calculateRequestCost`). */
export function calculateRequestCostDetailed(
  provider: string,
  model: string,
  tokens: CostTokenUsage | null | undefined,
  options: CostCalculationOptions = {}
): Promise<CostCalculationResult> {
  return calculateCostDetailed(provider, model, tokens, { ...options, requestScoped: true });
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
    const pricing = await resolvePricingRow(provider, model);
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
