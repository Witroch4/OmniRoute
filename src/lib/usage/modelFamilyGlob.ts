/**
 * Model "family" matching for budget routing rules.
 *
 * A family is deliberately a glob over the bare model id (`claude-opus-*`) and
 * not a new taxonomy: a glob picks up future members like `claude-opus-5` with
 * no code change, which is exactly the model that reached production unpriced
 * on 2026-07-25 and broke every USD figure. Only `*` is supported; every other
 * character is literal.
 */

import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";

function bareModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Whether `modelId` (with or without a provider prefix) belongs to `glob`. */
export function matchesFamilyGlob(modelId: string, glob: string): boolean {
  if (!modelId || !glob) return false;
  return globToRegExp(glob).test(bareModelId(modelId).toLowerCase());
}

/**
 * Whether `glob` would match `modelId` the way the spend query actually matches it:
 * `apiKeyUsageLimits.ts`'s `getApiKeyFamilyRealSpendSince` runs `LOWER(model) GLOB
 * @familyGlob` against the FULL stored model id, with no provider-prefix stripping --
 * unlike {@link matchesFamilyGlob} above, which strips up to the first `/` before
 * matching (see its own review-round note, carried into this final review as Finding 5).
 *
 * For a provider whose registry ids carry an internal slash (cline's
 * "anthropic/claude-sonnet-4.6", cloudflare-ai's "@cf/meta/...") a source glob with no
 * leading wildcard can match the BARE id (so the ladder decides a rule applies) while
 * never matching the FULL id the spend query scans -- spend then always reads 0, the
 * rule never exhausts, and the cap silently never fires. Used only to detect and warn
 * about that mismatch; not part of the matching decision itself.
 */
export function matchesFamilyGlobAgainstFullId(modelId: string, glob: string): boolean {
  if (!modelId || !glob) return false;
  return globToRegExp(glob).test(modelId.trim().toLowerCase());
}

/**
 * Numeric version of a model id, for "newest member" ordering: every digit run
 * in the id, in order (`claude-opus-5-5` -> [5, 5], `gpt-5.6-terra` -> [5, 6]).
 * Date-like runs (6+ digits, e.g. the `20251001` snapshot suffix) are dropped:
 * a snapshot is the same model as its undated alias, not a newer one.
 */
function modelVersion(modelId: string): number[] {
  return (modelId.match(/\d+/g) ?? []).filter((run) => run.length < 6).map(Number);
}

/** Positive when `a` is a newer version than `b`; missing components read as 0. */
function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolve a family glob to a concrete model id on `provider`: the NEWEST
 * registry member that matches, by the version numbers in its id — an
 * overflow always lands on the latest model of the target family, the same
 * rule the platform's bare `opus`/`sonnet` shortcuts follow.
 *
 * This used to take the first registry match and rely on the registry being
 * newest-first. That held until 2026-09-23, when `claude-opus-5-5` was listed
 * after `claude-opus-5` and every `fable -> claude-opus-*` overflow kept going
 * to the older model. Registry order now only breaks ties between ids with the
 * same version (effort tiers: `gpt-6-astra` before `gpt-6-astra-high`), so the
 * base id still wins there exactly as before.
 *
 * Returns null when the provider is unknown or nothing matches. Callers must
 * treat null as "no redirect" — a misconfigured rule is inert, never an error.
 */
export function resolveFamilyTargetModel(provider: string, glob: string): string | null {
  if (!provider || !glob) return null;
  const entry = getRegistryEntry(provider);
  if (!entry || !Array.isArray(entry.models)) return null;

  const ids = entry.models.map((model) => (typeof model?.id === "string" ? model.id : ""));
  return pickNewestFamilyMember(ids, glob);
}

/**
 * The newest id in `ids` matching `glob`; on a version tie the earlier id wins.
 * Pure, so the ordering rule is testable against any list, not only today's
 * registry (which happens to be newest-first and would hide a regression).
 */
export function pickNewestFamilyMember(ids: readonly string[], glob: string): string | null {
  if (!glob) return null;
  const pattern = globToRegExp(glob);
  let best: { id: string; version: number[] } | null = null;
  for (const id of ids) {
    if (!id || !pattern.test(id.toLowerCase())) continue;
    const version = modelVersion(id);
    // Strictly newer only: on a tie the earlier entry keeps the slot.
    if (!best || compareVersions(version, best.version) > 0) best = { id, version };
  }
  return best?.id ?? null;
}
