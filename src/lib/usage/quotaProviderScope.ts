export function normalizeQuotaProvider(value: string | null | undefined): string | null {
  const provider = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!provider) return null;
  if (["cc", "claude-code", "claudecode"].includes(provider)) return "claude";
  if (provider === "cx") return "codex";
  return provider;
}

export function resolveQuotaProviderScope(metadata: {
  preferredProvider?: string | null;
  allowedModels?: string[] | null;
}): string | null {
  const preferred = normalizeQuotaProvider(metadata.preferredProvider);
  if (preferred) return preferred;
  const providers = new Set<string>();
  const qualifiedModels = new Set<string>();
  const unprefixedModels: string[] = [];
  for (const pattern of metadata.allowedModels ?? []) {
    const parts = pattern.replace(/^no-think\//, "").split("/");
    if (parts.length < 2) {
      if (/[?*]/.test(parts[0])) return null;
      unprefixedModels.push(parts[0]);
      continue;
    }
    if (/[?*]/.test(parts[0])) return null;
    const provider = normalizeQuotaProvider(parts[0]);
    if (provider) providers.add(provider);
    qualifiedModels.add(parts.slice(1).join("/"));
  }
  if (unprefixedModels.some((model) => !qualifiedModels.has(model))) return null;
  return providers.size === 1 ? [...providers][0] : null;
}
