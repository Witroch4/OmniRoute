/**
 * What the official agy CLI sends per model, captured 2026-10-25 from agy 1.4.7 behind a
 * local TLS-terminating proxy that forwarded only the CLI's start-up metadata calls and
 * answered every generation itself (no generation reached Google), one run per model
 * (`handoffs/2026-10-25-agy-capture-proxy2.py`). Re-capture when the CLI version changes.
 *
 * Two things live here:
 * - the Cloud Code model enum (`fetchAvailableModels` → `models[id].model`, e.g.
 *   `gemini-3.8-flash-high` → `MODEL_PLACEHOLDER_M318`), echoed by the CLI in every
 *   generation request as `request.labels.model_enum`. The table below is the catalog the
 *   CLI received; `recordAntigravityModelEnums` keeps it current from every catalog
 *   OmniRoute fetches, so a renumbered or new model needs no release;
 * - the CLI's own `generationConfig` per model — an output cap and a thinking setting that
 *   differ by family: Gemini 3.8 Flash sends a numeric `thinkingBudget` (1000 / 4000 / -1),
 *   Gemini 4 Argon and Claude send `thinkingLevel`, GPT-OSS a budget of 8192; caps are
 *   65536 / 128000 / 32768.
 *
 * Leaf module: no imports.
 */

const CAPTURED_MODEL_ENUMS: Readonly<Record<string, string>> = Object.freeze({
  "claude-opus-5-5-high": "MODEL_PLACEHOLDER_M402",
  "claude-opus-5-5-low": "MODEL_PLACEHOLDER_M400",
  "claude-opus-5-5-medium": "MODEL_PLACEHOLDER_M401",
  "claude-sonnet-5-5-high": "MODEL_PLACEHOLDER_M405",
  "claude-sonnet-5-5-low": "MODEL_PLACEHOLDER_M403",
  "claude-sonnet-5-5-medium": "MODEL_PLACEHOLDER_M404",
  "gemini-2.5-flash": "MODEL_GOOGLE_GEMINI_2_5_FLASH",
  "gemini-2.5-flash-lite": "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
  "gemini-2.5-flash-thinking": "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
  "gemini-2.5-pro": "MODEL_GOOGLE_GEMINI_2_5_PRO",
  "gemini-3-flash": "MODEL_PLACEHOLDER_M18",
  "gemini-3.1-flash-image": "MODEL_PLACEHOLDER_M21",
  "gemini-3.1-flash-lite": "MODEL_PLACEHOLDER_M50",
  "gemini-3.5-flash-lite": "MODEL_PLACEHOLDER_M198",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
  "gemini-4-argon-high": "MODEL_PLACEHOLDER_M417",
  "gemini-4-argon-medium": "MODEL_PLACEHOLDER_M418",
  "gemini-4-argon-low": "MODEL_PLACEHOLDER_M419",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
});

const MODEL_ENUM_PATTERN = /^MODEL_[A-Z0-9_]+$/;
const liveModelEnums = new Map<string, string>();

/** Record `models[id].model` from a fetchAvailableModels `models` map. */
export function recordAntigravityModelEnums(models: unknown): void {
  if (!models || typeof models !== "object" || Array.isArray(models)) return;
  for (const [id, info] of Object.entries(models as Record<string, unknown>)) {
    const value =
      info && typeof info === "object" ? (info as Record<string, unknown>).model : undefined;
    if (typeof value === "string" && MODEL_ENUM_PATTERN.test(value)) {
      liveModelEnums.set(id, value);
    }
  }
}

export function lookupAntigravityModelEnum(modelId: string | null | undefined): string | null {
  if (typeof modelId !== "string" || !modelId) return null;
  return liveModelEnums.get(modelId) ?? CAPTURED_MODEL_ENUMS[modelId] ?? null;
}

export type AntigravityCliThinkingConfig = {
  includeThoughts: true;
  thinkingBudget?: number;
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
};

export type AntigravityCliGeneration = {
  maxOutputTokens: number;
  thinkingConfig: AntigravityCliThinkingConfig;
};

const budget = (maxOutputTokens: number, thinkingBudget: number): AntigravityCliGeneration => ({
  maxOutputTokens,
  thinkingConfig: { includeThoughts: true, thinkingBudget },
});
const level = (
  maxOutputTokens: number,
  thinkingLevel: "LOW" | "MEDIUM" | "HIGH"
): AntigravityCliGeneration => ({
  maxOutputTokens,
  thinkingConfig: { includeThoughts: true, thinkingLevel },
});

/** `generationConfig.maxOutputTokens` + `thinkingConfig` of the CLI's `agent` request. */
const CAPTURED_CLI_GENERATION: Readonly<Record<string, AntigravityCliGeneration>> = Object.freeze({
  "gemini-3.8-flash-high": budget(65536, -1),
  "gemini-3.8-flash-medium": budget(65536, 4000),
  "gemini-3.8-flash-low": budget(65536, 1000),
  "gemini-4-argon-high": level(65536, "HIGH"),
  "gemini-4-argon-medium": level(65536, "MEDIUM"),
  "gemini-4-argon-low": level(65536, "LOW"),
  "claude-opus-5-5-high": level(128000, "HIGH"),
  "claude-opus-5-5-medium": level(128000, "MEDIUM"),
  "claude-opus-5-5-low": level(128000, "LOW"),
  "claude-sonnet-5-5-high": level(128000, "HIGH"),
  "claude-sonnet-5-5-medium": level(128000, "MEDIUM"),
  "claude-sonnet-5-5-low": level(128000, "LOW"),
  "gpt-oss-120b-medium": budget(32768, 8192),
});

/** A fresh copy of what the CLI sends for `modelId`, or null when it was not captured. */
export function getAntigravityCliGeneration(
  modelId: string | null | undefined
): AntigravityCliGeneration | null {
  if (typeof modelId !== "string") return null;
  const entry = CAPTURED_CLI_GENERATION[modelId];
  if (!entry) return null;
  return { maxOutputTokens: entry.maxOutputTokens, thinkingConfig: { ...entry.thinkingConfig } };
}

/** True when `generationConfig` already carries exactly the CLI's cap and thinking setting. */
export function hasAntigravityCliGeneration(
  modelId: string | null | undefined,
  generationConfig: unknown
): boolean {
  const cli = getAntigravityCliGeneration(modelId);
  if (!cli || !generationConfig || typeof generationConfig !== "object") return false;
  const config = generationConfig as Record<string, unknown>;
  const thinking = config.thinkingConfig;
  if (config.maxOutputTokens !== cli.maxOutputTokens) return false;
  if (!thinking || typeof thinking !== "object") return false;
  const have = thinking as Record<string, unknown>;
  const want = cli.thinkingConfig as Record<string, unknown>;
  const keys = new Set([...Object.keys(have), ...Object.keys(want)]);
  for (const key of keys) {
    if (have[key] !== want[key]) return false;
  }
  return true;
}

/** @internal test helper */
export function resetAntigravityCliCatalogForTests(): void {
  liveModelEnums.clear();
}
