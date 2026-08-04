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
