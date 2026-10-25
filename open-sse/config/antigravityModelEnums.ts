/**
 * Cloud Code model enum per Antigravity model id (`fetchAvailableModels` →
 * `models[id].model`, e.g. `gemini-3.8-flash-high` → `MODEL_PLACEHOLDER_M318`).
 *
 * The official agy CLI echoes it in every generation request as
 * `request.labels.model_enum` (antigravityCliEnvelope.ts). The static table is the
 * catalog the CLI 1.4.7 received on 2026-10-25; `recordAntigravityModelEnums` keeps it
 * current from every catalog OmniRoute fetches, so a renumbered or new model is picked
 * up without a release. An id missing from both yields no `model_enum` label.
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

/** @internal test helper */
export function resetAntigravityModelEnumsForTests(): void {
  liveModelEnums.clear();
}
