/**
 * Model budget routing — the ladder decision.
 *
 * Walks a key's rules against REAL family spend in the current weekly window and
 * returns the provider/model that should actually serve the request, plus the
 * pair the client asked for (which is what the request gets billed as).
 *
 * Real spend, not normalized, is load-bearing here: a redirected request is
 * recorded with billed_model = the original family, so a normalized reading
 * would never attribute it to the family that SERVED it and the ladder could
 * never advance past its first rung.
 */

import { listModelBudgetRules, type ModelBudgetRule } from "@/lib/db/apiKeyModelBudgetRules";
import {
  getApiKeyFamilyRealSpendSince,
  getApiKeyWeeklyWindowStartIso,
  type ApiKeyUsageLimitMetadata,
} from "./apiKeyUsageLimits";
import { matchesFamilyGlob, resolveFamilyTargetModel } from "./modelFamilyGlob";

const MAX_HOPS = 4;
const CACHE_TTL_MS = 60_000;

export interface ModelBudgetRedirect {
  provider: string;
  model: string;
  billedProvider: string;
  billedModel: string;
  ruleId: string;
  hops: number;
}

export interface ModelBudgetRoutingDeps {
  listRules?: (apiKeyId: string) => ModelBudgetRule[];
  getFamilySpend?: (
    apiKeyId: string,
    provider: string,
    familyGlob: string,
    sinceIso: string
  ) => Promise<number>;
  resolveTarget?: (provider: string, glob: string) => string | null;
  getWindowStartIso?: () => Promise<string>;
  warn?: (message: string) => void;
}

type CacheEntry = { exhausted: boolean; expiresAt: number };
const spendCache = new Map<string, CacheEntry>();
const inertRulesWarned = new Set<string>();

export function clearModelBudgetRoutingCacheForTests(): void {
  spendCache.clear();
  inertRulesWarned.clear();
}

function cacheKey(apiKeyId: string, ruleId: string): string {
  return `${apiKeyId}::${ruleId}`;
}

async function isRuleExhausted(
  rule: ModelBudgetRule,
  apiKeyId: string,
  sinceIso: string,
  getFamilySpend: NonNullable<ModelBudgetRoutingDeps["getFamilySpend"]>,
  now: number
): Promise<boolean> {
  const key = cacheKey(apiKeyId, rule.id);
  const cached = spendCache.get(key);
  if (cached && cached.expiresAt > now) return cached.exhausted;

  const spent = await getFamilySpend(apiKeyId, rule.sourceProvider, rule.sourceFamily, sinceIso);
  const exhausted = spent >= rule.weeklyLimitUsd;
  spendCache.set(key, { exhausted, expiresAt: now + CACHE_TTL_MS });
  return exhausted;
}

/**
 * Resolve where this request should actually go. Returns null when no rule
 * applies, when every applicable rule is still under its cap, or when a rule is
 * inert (its target glob matches nothing on the target provider).
 */
export async function resolveModelBudgetRedirect(
  input: {
    apiKeyId: string;
    provider: string;
    model: string;
    usageLimitMetadata?: ApiKeyUsageLimitMetadata;
    now?: number;
  },
  deps: ModelBudgetRoutingDeps = {}
): Promise<ModelBudgetRedirect | null> {
  const apiKeyId = typeof input.apiKeyId === "string" ? input.apiKeyId : "";
  if (!apiKeyId || !input.provider || !input.model) return null;

  const listRules = deps.listRules ?? listModelBudgetRules;
  const rules = listRules(apiKeyId);
  if (rules.length === 0) return null;

  const now = input.now ?? Date.now();
  const getFamilySpend = deps.getFamilySpend ?? getApiKeyFamilyRealSpendSince;
  const resolveTarget = deps.resolveTarget ?? resolveFamilyTargetModel;
  const warn = deps.warn ?? ((message: string) => console.warn(`[BUDGET_ROUTING] ${message}`));
  const getWindowStartIso =
    deps.getWindowStartIso ??
    (() =>
      getApiKeyWeeklyWindowStartIso(
        input.usageLimitMetadata ?? { id: apiKeyId, allowedConnections: [] },
        {},
        now
      ));

  // Lazy + memoized: only paid for once a rule actually matches the current
  // provider/model, and at most once per call even across multiple hops —
  // the default getWindowStartIso does a real DB query, so a key with a rule
  // that simply doesn't apply to this request must not pay for it.
  let sinceIsoPromise: Promise<string> | null = null;
  const ensureSinceIso = (): Promise<string> => {
    if (!sinceIsoPromise) sinceIsoPromise = getWindowStartIso();
    return sinceIsoPromise;
  };

  const billedProvider = input.provider;
  const billedModel = input.model;
  let provider = input.provider;
  let model = input.model;
  let ruleId = "";
  let hops = 0;
  const visited = new Set<string>([`${provider}/${model}`.toLowerCase()]);

  // Among rules of equal priority, `id ASC` (a randomUUID tie-break) is
  // effectively random ordering — `Array.find` below picks the FIRST match
  // deterministically for a given `rules` array, but which rule that is when
  // priorities tie is arbitrary by design; no additional sort is added here.
  while (hops < MAX_HOPS) {
    const rule = rules.find(
      (candidate) =>
        candidate.sourceProvider.toLowerCase() === provider.toLowerCase() &&
        matchesFamilyGlob(model, candidate.sourceFamily)
    );
    if (!rule) break;

    const sinceIso = await ensureSinceIso();
    if (!(await isRuleExhausted(rule, apiKeyId, sinceIso, getFamilySpend, now))) break;

    const targetModel = resolveTarget(rule.targetProvider, rule.targetFamily);
    if (!targetModel) {
      if (!inertRulesWarned.has(rule.id)) {
        inertRulesWarned.add(rule.id);
        warn(
          `rule ${rule.id} is inert: target family "${rule.targetFamily}" matches no model on provider "${rule.targetProvider}"`
        );
      }
      break;
    }

    const next = `${rule.targetProvider}/${targetModel}`.toLowerCase();
    if (visited.has(next)) break;
    visited.add(next);

    provider = rule.targetProvider;
    model = targetModel;
    ruleId = rule.id;
    hops += 1;
  }

  if (hops === 0) return null;
  return { provider, model, billedProvider, billedModel, ruleId, hops };
}
