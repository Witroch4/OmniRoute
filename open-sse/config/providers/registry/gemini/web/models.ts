/**
 * Gemini Web (gemini.google.com) model catalog — the single source for both the registry
 * entry and the executor's model picker.
 *
 * `uiLabel` is the visible name of the entry in the web app's mode picker (measured
 * 2026-10-14 on a Pro account: "3.5 Flash Lite", "3.8 Flash", "3.1 Pro", "4 Argon"). The
 * executor drives the page, so a model is selected by clicking that entry — the request the
 * site then sends carries its own opaque model id (`x-goog-ext-525001261-jspb`, e.g.
 * `8c46e95b1a07cecc` for 3.5 Flash Lite), which we deliberately do not hard-code: it rotates
 * with the web app build, the visible name does not.
 *
 * ⚠️ Until 2026-10-14 the executor never selected anything: it typed into whatever the
 * account default was and echoed the requested id back, so every id here answered with the
 * same model.
 */

export interface GeminiWebModel {
  /** OmniRoute model id (what callers send as `gweb/<id>`). */
  id: string;
  /** Display name in the catalog. */
  name: string;
  /** Visible entry text in the web app's mode picker. */
  uiLabel: string;
  /** Extra texts the picker button itself may show for this model (e.g. "Argon" for "4 Argon"). */
  pillLabels?: readonly string[];
}

// Newest first, same convention as the other registries.
export const GEMINI_WEB_MODELS: readonly GeminiWebModel[] = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon", uiLabel: "4 Argon", pillLabels: ["Argon"] },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", uiLabel: "3.8 Flash" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", uiLabel: "3.1 Pro" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", uiLabel: "3.5 Flash Lite" },
];

export function findGeminiWebModel(id: string | null | undefined): GeminiWebModel | undefined {
  if (!id) return undefined;
  const bare = id.replace(/^(gweb|gemini-web)\//, "");
  return GEMINI_WEB_MODELS.find((m) => m.id === bare);
}
