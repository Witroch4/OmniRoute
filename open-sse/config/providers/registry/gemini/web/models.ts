/**
 * Gemini Web (gemini.google.com) model catalog — the single source for both the registry
 * entry and the executor's model picker.
 *
 * The executor drives the page, so a model is selected by clicking its entry in the web
 * app's mode picker. Measured live 2026-10-14 (Pro account):
 *
 *   menu entry          picker button after selecting
 *   "3.5 Flash Lite"    "Flash-Lite"
 *   "3.8 Flash"         "Flash"
 *   "3.1 Pro"           "Pro"
 *   "4 Argon"           "Argon"
 *
 * and every model offers the same three reasoning levels in the same menu
 * ("Mín." / "Médio" / "Máx."). OmniRoute exposes each (model, level) pair as its own id
 * (`-high` / `-medium` / `-low`, the tier convention the other Gemini providers use) so a
 * caller picks depth by model id, no extra parameter.
 *
 * The request the site sends carries its own opaque model id (`x-goog-ext-525001261-jspb`,
 * e.g. `8c46e95b1a07cecc` for 3.5 Flash Lite). It rotates with the web app build, the visible
 * names do not, so only the names are used.
 *
 * ⚠️ Until 2026-10-14 the executor selected nothing: it typed into whatever the account
 * default was and echoed the requested id back, so every id answered with the same model.
 */

export type GeminiWebReasoningLevel = "min" | "medium" | "max";

export interface GeminiWebModel {
  /** OmniRoute model id (what callers send as `gweb/<id>`). */
  id: string;
  /** Display name in the catalog. */
  name: string;
  /** Visible entry text in the web app's mode picker. */
  uiLabel: string;
  /** Texts the picker BUTTON shows once this model is selected (they differ from the menu). */
  pillLabels?: readonly string[];
  /** Reasoning level this id pins. Undefined = leave the account's saved level alone. */
  reasoning?: GeminiWebReasoningLevel;
}

/** Models as the picker offers them, newest first. */
export const GEMINI_WEB_BASE_MODELS: readonly GeminiWebModel[] = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon", uiLabel: "4 Argon", pillLabels: ["Argon"] },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", uiLabel: "3.8 Flash", pillLabels: ["Flash"] },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", uiLabel: "3.1 Pro", pillLabels: ["Pro"] },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    uiLabel: "3.5 Flash Lite",
    pillLabels: ["Flash-Lite"],
  },
];

/** The three reasoning levels of the picker: suffix → level (the page says Mín. / Médio / Máx.). */
export const GEMINI_WEB_REASONING_TIERS: ReadonlyArray<{
  suffix: "high" | "medium" | "low";
  level: GeminiWebReasoningLevel;
  label: string;
}> = [
  { suffix: "high", level: "max", label: "Max" },
  { suffix: "medium", level: "medium", label: "Medium" },
  { suffix: "low", level: "min", label: "Min" },
];

/** The catalog: one id per (model, reasoning level). */
export const GEMINI_WEB_MODELS: readonly GeminiWebModel[] = GEMINI_WEB_BASE_MODELS.flatMap((base) =>
  GEMINI_WEB_REASONING_TIERS.map((tier) => ({
    ...base,
    id: `${base.id}-${tier.suffix}`,
    name: `${base.name} (${tier.label} reasoning)`,
    reasoning: tier.level,
  }))
);

/** Every text the picker button can show for any model. */
export const GEMINI_WEB_PICKER_LABELS: readonly string[] = GEMINI_WEB_BASE_MODELS.flatMap((m) => [
  m.uiLabel,
  ...(m.pillLabels ?? []),
]);

/**
 * Resolve a requested id. Tier ids pin a reasoning level; a bare base id ("gemini-4-argon")
 * is accepted too and means "that model, leave the level alone" — it is not listed in the
 * catalog, so the three tiers are the advertised surface.
 */
export function findGeminiWebModel(id: string | null | undefined): GeminiWebModel | undefined {
  if (!id) return undefined;
  const bare = id.replace(/^(gweb|gemini-web)\//, "");
  return (
    GEMINI_WEB_MODELS.find((m) => m.id === bare) ??
    GEMINI_WEB_BASE_MODELS.find((m) => m.id === bare)
  );
}
