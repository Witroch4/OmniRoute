export const ANTIGRAVITY_PUBLIC_MODELS = Object.freeze([
  // Claude (Antigravity backend). Same backend as the `agy` provider (see agyModels.ts);
  // discussion #3184 confirmed Claude is user-callable through the `antigravity` OAuth
  // provider too.
  //
  // 2026-10-10: Google RETIRED Claude 4.6 on this backend and replaced it with Claude 5.5,
  // exposed as three effort tiers per family. Verified with `agy models` (CLI 1.3.3) and a
  // real `claude-sonnet-5-5-low` completion on the account; `claude-sonnet-4-6` is now
  // rejected by the CLI as "not a known model", and the backend answers a 200 with the
  // text "Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5."
  // The tier ids are the real upstream ids (no alias needed). The retired 4.6 ids and the
  // `claude-sonnet-5` placeholder stay callable as HIDDEN aliases below (see
  // ANTIGRAVITY_MODEL_ALIASES) so saved combos keep routing; they are NOT re-advertised.
  // contextLength/maxOutputTokens are the conservative values the 4.6 entries carried —
  // not probed for 5.5 yet; raise them once measured.
  {
    id: "claude-opus-5-5-high",
    name: "Claude Opus 5.5 (High)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-opus-5-5-medium",
    name: "Claude Opus 5.5 (Medium)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-opus-5-5-low",
    name: "Claude Opus 5.5 (Low)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-5-5-high",
    name: "Claude Sonnet 5.5 (High)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-5-5-medium",
    name: "Claude Sonnet 5.5 (Medium)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-5-5-low",
    name: "Claude Sonnet 5.5 (Low)",
    contextLength: 200000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Gemini 3.8 Flash tiers (Low/Medium/High) — the current Flash line; `agy models` (CLI
  // 1.4.6, 2026-10-23) lists exactly these three. There is no bare id: `gemini-3.8-flash`
  // returned 404, so the tiers ARE the real upstream ids and nothing is aliased.
  // 2026-10-23 — Gemini 3.5, 3.6 and 3.7 Flash and Gemini 3.1 Pro (-high/-low, -agent)
  // were removed: Google retired them (3.5 answers 200 with a fixed "no longer
  // available" notice, the others answer 404) and `agy models` no longer lists them.
  {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.8-flash-medium",
    name: "Gemini 3.8 Flash (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.8-flash-low",
    name: "Gemini 3.8 Flash (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
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
  {
    id: "gemini-2.5-flash-thinking",
    name: "Gemini 2.5 Flash Thinking",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    contextLength: 131072,
    maxOutputTokens: 32768,
    supportsReasoning: true,
    toolCalling: true,
  },
  { id: "gemini-3-pro-image-preview", name: "Gemini 3 Pro Image" },
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" },
  {
    id: "gemini-2.5-computer-use-preview-10-2025",
    name: "Gemini 2.5 Computer Use Preview (10/2025)",
  },
]);

export const ANTIGRAVITY_MODEL_ALIASES = Object.freeze({
  // Gemini 3.5/3.6/3.7 Flash and Gemini 3.1 Pro were removed on 2026-10-23 (retired by Google),
  // so they have NO alias: nothing forwards a retired id to a live one (see the catalog notes).
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-2.5-computer-use-preview-10-2025": "rev19-uic3-1p",
  // Retired Claude ids → the live Claude 5.5 tiers (HIDDEN aliases, not advertised).
  // The backend dropped Claude 4.6 on 2026-10-10 (see the catalog note above), so these ids
  // would otherwise reach upstream and come back as a 200 "no longer available" text that
  // health probes read as healthy. They map to the High tier because the retired entries
  // were the "(Thinking)" models and High is the default effort of 5.5. `claude-sonnet-5`
  // was only ever a placeholder here (served by 4.6 upstream), so it follows the same path.
  // Resolution is single-step: every target below must be a live upstream id.
  "claude-sonnet-4-6": "claude-sonnet-5-5-high",
  "claude-opus-4-6-thinking": "claude-opus-5-5-high",
  "claude-sonnet-5": "claude-sonnet-5-5-high",
  // Legacy Claude display ids → live upstream ids (same successors as above).
  "gemini-claude-sonnet-4-5": "claude-sonnet-5-5-high",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-5-5-high",
  "gemini-claude-opus-4-5-thinking": "claude-opus-5-5-high",
});

type AntigravityModelAliasMap = Record<string, string>;

/**
 * Per-request upstream-id FALLBACK CHAINS (the executor retries the next id on a 400).
 * Both chains covered models Google has since retired (Gemini 3.1 Pro -high/-low and Gemini
 * 3.5 Flash Low), so a retry could only land on another dead id; they were emptied on
 * 2026-10-23. The exports stay because the executor resolves chains by id through
 * `getAntigravityModelFallbacks` — add an entry only for a LIVE model that needs one.
 */
export const ANTIGRAVITY_PRO_FALLBACK_CHAINS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({});

export const ANTIGRAVITY_FLASH_FALLBACK_CHAINS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({});

export const ANTIGRAVITY_MODEL_FALLBACK_CHAINS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    ...ANTIGRAVITY_PRO_FALLBACK_CHAINS,
    ...ANTIGRAVITY_FLASH_FALLBACK_CHAINS,
  });

/**
 * Return the ordered upstream-id fallback chain for `modelId` (the requested id first), or
 * `[]` when the model has no chain. Pure — safe to unit test and to call on every request
 * (returns `[]` cheaply off the happy path's hot models).
 */
export function getAntigravityModelFallbacks(modelId: string): readonly string[] {
  if (!modelId) return [];
  return ANTIGRAVITY_MODEL_FALLBACK_CHAINS[modelId] ?? [];
}

export const ANTIGRAVITY_REVERSE_MODEL_ALIASES: AntigravityModelAliasMap = Object.freeze({
  "gemini-3-pro-image": "gemini-3-pro-image-preview",
  "rev19-uic3-1p": "gemini-2.5-computer-use-preview-10-2025",
});

const CLIENT_VISIBLE_MODEL_NAMES = Object.freeze(
  ANTIGRAVITY_PUBLIC_MODELS.reduce<Record<string, string>>((acc, model) => {
    acc[model.id] = model.name;
    return acc;
  }, {})
);

const PUBLIC_MODEL_IDS = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));
const UPSTREAM_PUBLIC_MODEL_IDS = new Set(
  ANTIGRAVITY_PUBLIC_MODELS.map((model) => resolveAntigravityModelId(model.id))
);

export function resolveAntigravityModelId(modelId: string): string {
  if (!modelId) return modelId;
  return (ANTIGRAVITY_MODEL_ALIASES as AntigravityModelAliasMap)[modelId] || modelId;
}

export function toClientAntigravityModelId(modelId: string): string {
  if (!modelId) return modelId;
  return ANTIGRAVITY_REVERSE_MODEL_ALIASES[modelId] || modelId;
}

// Quota buckets reported by the Antigravity backend are keyed by UPSTREAM model ids — a
// DIFFERENT namespace from the public/client catalog. In that upstream quota namespace
// `gemini-3.5-flash-low` denotes the *Medium* tier's bucket (it is the upstream target of
// the `gemini-3.5-flash-medium` forward alias), even though the same literal is also a
// public "Low" client id. This remap therefore CANNOT be derived from
// ANTIGRAVITY_REVERSE_MODEL_ALIASES (which has no `gemini-3.5-flash-low` entry precisely
// because it is already a valid client id) — it encodes the upstream-bucket → client-tier
// chain explicitly. Keep it the inverse of the `-low/-medium/-high` rows in
// ANTIGRAVITY_MODEL_ALIASES above. (#3821-review LEDGER-5 — was duplicated as an inline
// if-ladder in open-sse/services/usage.ts.)
const ANTIGRAVITY_QUOTA_BUCKET_TO_CLIENT: AntigravityModelAliasMap = Object.freeze({
  "gemini-3.5-flash-extra-low": "gemini-3.5-flash-low",
  "gemini-3.5-flash-low": "gemini-3.5-flash-medium",
  "gemini-3-flash-agent": "gemini-3.5-flash-high",
});

// Retired/hidden upstream preview buckets that must be dropped from client-facing usage.
const ANTIGRAVITY_DROPPED_QUOTA_BUCKETS = new Set<string>([
  "gemini-3.5-flash-preview",
  "gemini-3-flash-preview",
]);

/**
 * Map an UPSTREAM Antigravity quota-bucket model id to the client-visible tier id used in
 * usage responses, or `null` if the bucket should be hidden from clients. Operates on the
 * upstream quota namespace (see ANTIGRAVITY_QUOTA_BUCKET_TO_CLIENT) — do NOT pass client
 * ids here. Single source of truth shared by the usage service and the provider-limits
 * cache sanitizer.
 */
export function toClientAntigravityQuotaModelId(modelId: string): string | null {
  if (!modelId) return null;
  if (ANTIGRAVITY_DROPPED_QUOTA_BUCKETS.has(modelId)) return null;
  const tierClientId = ANTIGRAVITY_QUOTA_BUCKET_TO_CLIENT[modelId];
  if (tierClientId) return tierClientId;
  return toClientAntigravityModelId(modelId);
}

export function getClientVisibleAntigravityModelName(
  modelId: string,
  fallbackName?: string
): string {
  return CLIENT_VISIBLE_MODEL_NAMES[modelId] || fallbackName || modelId;
}

export function isUserCallableAntigravityModelId(modelId: string): boolean {
  if (!modelId) return false;
  const clientId = toClientAntigravityModelId(modelId);
  const upstreamId = resolveAntigravityModelId(modelId);
  return PUBLIC_MODEL_IDS.has(clientId) || UPSTREAM_PUBLIC_MODEL_IDS.has(upstreamId);
}
