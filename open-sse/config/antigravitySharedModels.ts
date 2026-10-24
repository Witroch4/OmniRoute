// Models served by BOTH Antigravity surfaces (`agy` CLI and `antigravity` IDE) on the
// shared Cloud Code backend.
//
// Fork note: the per-surface catalogs (`agyModels.ts`, `antigravityModelAliases.ts`) stay
// explicit lists — they differ (agy carries the image model, antigravity carries Computer
// Use and the Gemini 3 Pro image preview) and are pinned from `agy models` / live probes.
// This module is the curated common subset under the same invariants: no retired Gemini
// (3.5/3.6/3.7 Flash, 3.1 Pro, `gemini-pro-agent`, `gemini-3-pro-preview` — see
// antigravityRetiredModels.ts), no `-tiered` aliases (the tiers are the real upstream ids),
// no Claude 4.6 (retired 2026-10-10) and no Argon in the static catalog (live discovery
// may still publish what Google lists for the account).

export const ANTIGRAVITY_SHARED_MODELS = Object.freeze([
  // Claude 5.5 tiers (Antigravity backend); conservative limits, not probed for 5.5 yet.
  ...(["opus", "sonnet"] as const).flatMap((family) =>
    (["high", "medium", "low"] as const).map((tier) => ({
      id: `claude-${family}-5-5-${tier}`,
      name: `Claude ${family === "opus" ? "Opus" : "Sonnet"} 5.5 (${tier[0].toUpperCase()}${tier.slice(1)})`,
      contextLength: 200000,
      maxOutputTokens: 65536,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    }))
  ),
  // Gemini 3.8 Flash tiers — served directly at these ids; there is no bare id.
  ...(["high", "medium", "low"] as const).map((tier) => ({
    id: `gemini-3.8-flash-${tier}`,
    name: `Gemini 3.8 Flash (${tier[0].toUpperCase()}${tier.slice(1)})`,
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  })),
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  // GPT-OSS
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    contextLength: 131072,
    maxOutputTokens: 32768,
    supportsReasoning: true,
    toolCalling: true,
  },
]);

/**
 * Build a surface-specific catalog from the shared base plus an explicit delta.
 * This preserves the ability for agy/antigravity to diverge in the future while
 * keeping today's single-edit maintenance path.
 */
export function buildSurfaceCatalog<T extends { id: string }>(
  base: readonly T[],
  delta: { add?: readonly T[]; remove?: readonly string[] } = {}
): readonly T[] {
  const removed = new Set(delta.remove ?? []);
  const added = delta.add ?? [];
  const filtered = base.filter((m) => !removed.has(m.id));
  return Object.freeze([...filtered, ...added]);
}
