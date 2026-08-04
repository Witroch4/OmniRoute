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
 * Resolve a family glob to a concrete model id on `provider`, by taking the
 * first registry member that matches. Registry order is newest-first within a
 * family (verified in open-sse/config/providers/registry/claude/index.ts, where
 * claude-sonnet-5 precedes claude-sonnet-4-6 precedes claude-sonnet-4-5-*), so
 * "first match" means "newest member".
 *
 * Returns null when the provider is unknown or nothing matches. Callers must
 * treat null as "no redirect" — a misconfigured rule is inert, never an error.
 */
export function resolveFamilyTargetModel(provider: string, glob: string): string | null {
  if (!provider || !glob) return null;
  const entry = getRegistryEntry(provider);
  if (!entry || !Array.isArray(entry.models)) return null;

  const pattern = globToRegExp(glob);
  for (const model of entry.models) {
    const id = typeof model?.id === "string" ? model.id : "";
    if (id && pattern.test(id.toLowerCase())) return id;
  }
  return null;
}
