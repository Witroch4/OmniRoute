// Antigravity CLI (`agy`) model catalog.
//
// These models are pinned from the live `:fetchAvailableModels` endpoint
// (https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels) using a
// real `agy` consumer-OAuth token.
//
// The `agy` provider reuses the `antigravity` executor/translator (identical backend),
// but ships its OWN catalog so it can expose models the `antigravity` provider's static
// list omits — notably the Claude models, which the backend reports as user-callable
// with quota even though the `antigravity` catalog comment once assumed they 404.
// Tab-completion models (`tab_flash_lite_preview`, `tab_jump_flash_lite_preview`) are
// intentionally excluded — they are not chat-callable.
//
// 2026-10-10 — Claude moved from 4.6 to 5.5 on this backend. `agy models` (CLI 1.3.3)
// lists `claude-{opus,sonnet}-5-5-{low,medium,high}` and no 4.6; a real
// `claude-sonnet-5-5-low` completion succeeded on the account. The OM probe still
// reported the retired 4.6 ids (same pattern as the Gemini 3.7/3.8 tiers below, which
// the probe also never advertised), so the 5.5 tiers are pinned here. The retired 4.6
// ids are kept only as hidden aliases in antigravityModelAliases.ts.

import {
  ANTIGRAVITY_QUOTA_VISIBLE_NON_CHAT_MODEL_IDS,
  isRetiredAntigravityCatalogId,
} from "./antigravityModelAliases.ts";

export const AGY_PUBLIC_MODELS = Object.freeze([
  // Claude 5.5 (Antigravity backend) — the headline differentiator for this provider.
  // Limits are the conservative values the 4.6 entries carried; not probed for 5.5 yet.
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
  // Gemini 3.x
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
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" },
  // Gemini 2.5
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
    id: "gemini-2.5-flash-thinking",
    name: "Gemini 2.5 Flash Thinking",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    supportsReasoning: true,
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

const AGY_PUBLIC_MODEL_IDS = new Set(AGY_PUBLIC_MODELS.map((model) => model.id));
const AGY_NON_CHAT_MODEL_IDS = new Set(["tab_flash_lite_preview", "tab_jump_flash_lite_preview"]);
const AGY_NON_CHAT_MODEL_PATTERN =
  /(?:^|[-_])(image|imagen|audio|tts|embedding|embed|video|veo)(?:[-_]|$)/i;
// Retired ids: the shared Antigravity rule (upstream's retired list plus every id the
// chat pipeline refuses), never touching a model this catalog still publishes — Gemini
// 2.5, 3.1 Flash Lite and the image model stay callable on `agy` (fork catalog).
function isRetiredAgyModelId(id: string): boolean {
  return !AGY_PUBLIC_MODEL_IDS.has(id) && isRetiredAntigravityCatalogId(id);
}

const AGY_CLIENT_VISIBLE_MODEL_NAMES = Object.freeze(
  AGY_PUBLIC_MODELS.reduce<Record<string, string>>((acc, model) => {
    acc[model.id] = model.name;
    return acc;
  }, {})
);

export function getClientVisibleAgyModelName(modelId: string, fallbackName?: string): string {
  return AGY_CLIENT_VISIBLE_MODEL_NAMES[modelId] || fallbackName || modelId;
}

export function isUserCallableAgyModelId(modelId: string): boolean {
  return !!modelId && AGY_PUBLIC_MODEL_IDS.has(modelId);
}

export function isDiscoverableAgyModelId(modelId: string): boolean {
  const id = modelId ? modelId.trim() : "";
  return (
    !!id &&
    !id.startsWith("chat_") &&
    !id.startsWith("tab_") &&
    !id.endsWith("_weekly") &&
    !AGY_NON_CHAT_MODEL_IDS.has(id) &&
    !isRetiredAgyModelId(id) &&
    !AGY_NON_CHAT_MODEL_PATTERN.test(id)
  );
}

/**
 * Quota visibility is broader than chat discovery (same rule as Antigravity): image-only models
 * keep their live quota buckets in Provider Limits even though they are not chat models, so
 * `AGY_NON_CHAT_MODEL_PATTERN` must not hide them.
 */
export function isUserVisibleAgyQuotaModelId(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return false;
  return isDiscoverableAgyModelId(id) || ANTIGRAVITY_QUOTA_VISIBLE_NON_CHAT_MODEL_IDS.has(id);
}
