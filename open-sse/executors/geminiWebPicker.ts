/**
 * Gemini Web model picker — drives the web app's mode picker (model + reasoning level).
 *
 * Kept apart from the executor so it has no heavy imports (only the catalog): it can be unit
 * tested against a stub document AND bundled on its own to run against the real page on the
 * production host before a build.
 */

import {
  GEMINI_WEB_PICKER_LABELS,
  type GeminiWebModel,
  type GeminiWebReasoningLevel,
} from "../config/providers/registry/gemini/web/models.ts";

// ─── Model picker ───────────────────────────────────────────────────────────
//
// Measured live 2026-10-14:
//  - the picker button shows a SHORT name once a model is selected ("Flash-Lite", "Flash",
//    "Pro", "Argon" — not the menu's "3.5 Flash Lite", …) and, after a level was chosen, the
//    level too ("Argon Médio", aria "…No momento: Argon Médio"); the level is saved on the
//    account, so the next session opens already showing it;
//  - a session carrying only __Secure-1PSID/__Secure-1PSIDTS is served the SIGNED-OUT page:
//    "Sign in" buttons, "Sign in for all models", menu in English with "3.5 Flash-Lite"
//    (hyphen) and most entries `aria-disabled="true"`. Only the full Cookie header of a
//    signed-in session gets the account's models.
// The web app answers with whatever model its mode picker currently shows, so selecting a
// model means driving that picker BEFORE typing the prompt. The page scripts are plain
// strings so this file needs no DOM typings and a test can run them against a stub
// `document`.

export class GeminiWebModelSelectionError extends Error {
  /**
   * 400: this session's picker does not offer (or has disabled) the model — answered as
   *      `model_not_found`, which OmniRoute treats as "try another account" with ZERO cooldown.
   *      (A 404 here put the whole connection in cooldown, so one unavailable model blocked
   *      every other model for minutes — measured in production 2026-10-14.)
   * 401: the session is not signed in (cookie rejected / incomplete) — credentials problem.
   * 502: the picker could not be driven (UI drift) — a real connection fault.
   */
  readonly status: 400 | 401 | 502;

  constructor(status: 400 | 401 | 502, message: string) {
    super(message);
    this.name = "GeminiWebModelSelectionError";
    this.status = status;
  }
}

/** The slice of Playwright's `Page` the picker needs. */
export interface GeminiWebPickerPage {
  /**
   * Evaluates a JavaScript EXPRESSION in the page and returns its value. Playwright (Node)
   * does not call a string that happens to be a function and never passes it an argument —
   * measured live 2026-10-14: `evaluate("(a) => …", arg)` returned undefined. Use
   * `runPageScript`, which emits a self-invoking expression.
   */
  evaluate<R>(expression: string): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): { first(): { click(options?: { timeout?: number }): Promise<void> } };
}

interface PickerState {
  text: string;
  aria: string;
  /** The page shows "Sign in" controls: the cookie did not authenticate the session. */
  signedOut: boolean;
}

interface ItemState {
  found: boolean;
  /** `aria-disabled="true"` — present in the menu but not selectable for this session. */
  disabled: boolean;
}

/** Run a function-valued page script with one JSON argument, as a self-invoking expression. */
function runPageScript<R>(page: GeminiWebPickerPage, script: string, arg: unknown): Promise<R> {
  return page.evaluate<R>(`(${script})(${JSON.stringify(arg ?? null)})`);
}

const PICKER_ATTR = "data-omni-gweb-picker";
const ITEM_ATTR = "data-omni-gweb-item";
const PICKER_POLL_MS = 250;
// A click that cannot land (entry disabled, covered by an overlay) must fail fast and say so,
// not sit on Playwright's 30 s actionability wait. Each failed attempt re-tags the target.
const CLICK_TIMEOUT_MS = 5_000;
const CLICK_ATTEMPTS = 3;

// Finds the picker button (by its aria-label, which is localized — or by its visible model name
// as a fallback), tags it, and reports what it shows and whether the page is signed out.
const TAG_PICKER_SCRIPT = `(known) => {
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  document.querySelectorAll("[${PICKER_ATTR}]").forEach((el) => el.removeAttribute("${PICKER_ATTR}"));
  const ariaRe = /seletor de modo|mode picker|model picker|selecionar modelo|choose.{0,12}model/i;
  const signInRe = /^(sign in|fazer login|entrar|iniciar sess[aã]o|iniciar sesi[oó]n)$/i;
  // Only what is on screen: on a slow host (the production ARM box takes >3 s to render) a
  // hidden or half-mounted node must never be the one tagged and clicked.
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.getAttribute("aria-hidden") !== "true";
  };
  const buttons = Array.from(document.querySelectorAll("button, [role='button']")).filter(visible);
  // The button's own text is a short word ("Pro", "Flash") that can also appear elsewhere on
  // the page, so its aria-label wins; the text is only a fallback for a relabelled button.
  const el =
    buttons.find((b) => ariaRe.test(norm(b.getAttribute("aria-label")))) ||
    buttons.find((b) => known.includes(norm(b.innerText)));
  if (!el) return null;
  el.setAttribute("${PICKER_ATTR}", "1");
  const signedOut = Array.from(document.querySelectorAll("a, button")).some((e) =>
    signInRe.test(norm(e.innerText))
  );
  return { text: norm(el.innerText), aria: norm(el.getAttribute("aria-label")), signedOut };
}`;

// What the open menu actually offers (first words of each entry), for error messages.
const LIST_ITEMS_SCRIPT = `() => {
  const items = document.querySelectorAll(
    "[role='menuitemradio'], [role='menuitem'], [role='option'], button[mat-menu-item]"
  );
  return Array.from(items)
    .map((el) => String(el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 28))
    .filter(Boolean)
    .slice(0, 12);
}`;

// Tags the open menu's entry whose visible text matches `source`.
const TAG_ITEM_SCRIPT = `(source) => {
  const re = new RegExp(source);
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  document.querySelectorAll("[${ITEM_ATTR}]").forEach((el) => el.removeAttribute("${ITEM_ATTR}"));
  const items = document.querySelectorAll(
    "[role='menuitemradio'], [role='menuitem'], [role='option'], button[mat-menu-item]"
  );
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    if (re.test(norm(el.innerText))) {
      el.setAttribute("${ITEM_ATTR}", "1");
      return { found: true, disabled: el.getAttribute("aria-disabled") === "true" };
    }
  }
  return { found: false, disabled: false };
}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source matching a menu entry's text for `model` (entries read "3.8 Flash Ajuda para tudo"). */
export function geminiWebMenuItemPattern(model: GeminiWebModel): string {
  // "3.8 Flash" must not select a sibling "3.8 Flash Lite"; "3.1 Pro" must not select "3.1 Pro2".
  const notLite = /\bLite$/i.test(model.uiLabel) ? "" : "(?!\\s+Lite\\b)";
  // The signed-out menu spells it "3.5 Flash-Lite", the signed-in one "3.5 Flash Lite".
  const label = model.uiLabel.split(/\s+/).map(escapeRegExp).join("[\\s-]+");
  return `^\\s*${label}(?![\\w.])${notLite}`;
}

// ─── Reasoning level (read side) ────────────────────────────────────────────

export type { GeminiWebReasoningLevel };

// Trailing level word on the picker button ("Argon Médio"). pt-BR measured; English accepted.
const LEVEL_SUFFIX = /\s+(M[ií]n\.?|M[ée]dio|M[áa]x\.?|Min|Medium|Max)$/i;

function levelFromWord(word: string): GeminiWebReasoningLevel {
  if (/^m[ií]n/i.test(word)) return "min";
  if (/^m[ée]d/i.test(word)) return "medium";
  return "max";
}

/** The level the picker button currently shows, or null when it shows none. */
function pickerLevel(state: PickerState | null): GeminiWebReasoningLevel | null {
  if (!state) return null;
  for (const value of [state.text, state.aria]) {
    const match = LEVEL_SUFFIX.exec(value);
    if (match) return levelFromWord(match[1]);
  }
  return null;
}

/** "Argon Médio" → "Argon"; hyphens read as spaces ("Flash-Lite" ≡ "Flash Lite"). */
function flattenPickerLabel(value: string): string {
  return value.replace(LEVEL_SUFFIX, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function pickerShows(state: PickerState | null, model: GeminiWebModel): boolean {
  if (!state) return false;
  const text = flattenPickerLabel(state.text);
  const aria = flattenPickerLabel(state.aria);
  return [model.uiLabel, ...(model.pillLabels ?? [])].some((raw) => {
    const label = flattenPickerLabel(raw);
    // The aria-label ends with the current model's name ("…No momento: Flash-Lite"); require a
    // word boundary so the "Flash" button is not mistaken for "Flash Lite" or the reverse.
    return text === label || new RegExp(`(^|[^\\w])${escapeRegExp(label)}$`).test(aria);
  });
}

async function clickTagged(
  page: GeminiWebPickerPage,
  attr: string,
  what: string,
  retag: () => Promise<boolean>
): Promise<void> {
  // The web app re-renders these nodes while it settles, which drops our tag attribute and
  // leaves the locator waiting for a node that no longer exists. Re-tag and try again.
  let reason = "unknown";
  for (let attempt = 1; attempt <= CLICK_ATTEMPTS; attempt++) {
    try {
      await page.locator(`[${attr}]`).first().click({ timeout: CLICK_TIMEOUT_MS });
      return;
    } catch (err) {
      reason = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : "unknown";
      if (attempt === CLICK_ATTEMPTS) break;
      await page.waitForTimeout(PICKER_POLL_MS);
      if (!(await retag())) break;
    }
  }
  throw new GeminiWebModelSelectionError(502, `Gemini Web: could not click ${what} (${reason}).`);
}

function signedOutError(): GeminiWebModelSelectionError {
  return new GeminiWebModelSelectionError(
    401,
    "Gemini Web: the session cookie is not signed in — Google served the signed-out page, where " +
      "most models are disabled. Paste the FULL Cookie header of a signed-in gemini.google.com " +
      "session (DevTools → Network → any gemini.google.com request → Cookie); __Secure-1PSID " +
      "alone is not enough."
  );
}

async function readPicker(
  page: GeminiWebPickerPage,
  known: string[],
  timeoutMs: number
): Promise<PickerState | null> {
  for (let waited = 0; waited <= timeoutMs; waited += PICKER_POLL_MS) {
    const state = await runPageScript<PickerState | null>(page, TAG_PICKER_SCRIPT, known);
    if (state) return state;
    await page.waitForTimeout(PICKER_POLL_MS);
  }
  return null;
}

async function pollItem(
  page: GeminiWebPickerPage,
  source: string,
  timeoutMs: number
): Promise<ItemState> {
  let last: ItemState = { found: false, disabled: false };
  for (let waited = 0; waited <= timeoutMs; waited += PICKER_POLL_MS) {
    last = await runPageScript<ItemState>(page, TAG_ITEM_SCRIPT, source);
    if (last.found) return last;
    await page.waitForTimeout(PICKER_POLL_MS);
  }
  return last;
}

/**
 * Make the web app's mode picker show `model`, or throw `GeminiWebModelSelectionError`.
 * Never falls through silently: answering with a different model than the one requested is
 * the bug this replaces.
 */
export async function selectGeminiWebModel(
  page: GeminiWebPickerPage,
  model: GeminiWebModel,
  timeoutMs = 10_000
): Promise<void> {
  const known = [...GEMINI_WEB_PICKER_LABELS];

  const state = await readPicker(page, known, timeoutMs);
  if (!state) {
    throw new GeminiWebModelSelectionError(
      502,
      "Gemini Web: the model picker was not found on the page (the web app may have changed), " +
        "so the requested model cannot be selected."
    );
  }
  if (state.signedOut) throw signedOutError();
  if (pickerShows(state, model)) return;

  const retagPicker = async () =>
    !!(await runPageScript<PickerState | null>(page, TAG_PICKER_SCRIPT, known));
  await clickTagged(page, PICKER_ATTR, "the model picker", retagPicker);

  const item = await pollItem(page, geminiWebMenuItemPattern(model), 5_000);
  if (!item.found || item.disabled) {
    const offered = await runPageScript<string[]>(page, LIST_ITEMS_SCRIPT, null).catch(
      () => [] as string[]
    );
    throw new GeminiWebModelSelectionError(
      400,
      `Gemini Web: model "${model.uiLabel}" is not ${item.found ? "enabled for" : "available in"} ` +
        `this account's model picker (plan or staged rollout). ` +
        `The picker offered: ${offered.length ? offered.join(" | ") : "nothing"}.`
    );
  }
  const itemPattern = geminiWebMenuItemPattern(model);
  await clickTagged(
    page,
    ITEM_ATTR,
    `the "${model.uiLabel}" entry`,
    async () => (await runPageScript<ItemState>(page, TAG_ITEM_SCRIPT, itemPattern)).found
  );

  for (let waited = 0; waited <= 4_000; waited += PICKER_POLL_MS) {
    await page.waitForTimeout(PICKER_POLL_MS);
    const after = await runPageScript<PickerState | null>(page, TAG_PICKER_SCRIPT, known);
    if (pickerShows(after, model)) return;
  }
  throw new GeminiWebModelSelectionError(
    502,
    `Gemini Web: selecting "${model.uiLabel}" did not take effect in the model picker.`
  );
}

// ─── Reasoning level ────────────────────────────────────────────────────────
//
// The same menu carries a "Nível de raciocínio" section with three entries (measured
// 2026-10-14: "Mín. Rápido e eficiente", "Médio Aprofundamento equilibrado", "Máx. Muito
// detalhado"). Like the model, the level is a picker state saved on the account: unset, the
// page uses whatever was chosen last. It is driven only when the id or the caller asks.

/** OpenAI-style effort → the web app's three levels. Unknown values are ignored (null). */
export function resolveGeminiWebReasoning(effort: unknown): GeminiWebReasoningLevel | null {
  if (typeof effort !== "string") return null;
  switch (effort.trim().toLowerCase()) {
    case "none":
    case "minimal":
    case "min":
    case "low":
      return "min";
    case "medium":
    case "med":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "max";
    default:
      return null;
  }
}

// The section title and level names are localized; both pt-BR (observed) and English are accepted.
const REASONING_SECTION_PATTERN =
  "^\\s*(?:N[ií]vel de racioc[ií]nio|Reasoning level|Thinking level|N[ií]vel de pensamento)";
const REASONING_LEVEL_PATTERNS: Record<GeminiWebReasoningLevel, string> = {
  min: "^\\s*(?:M[ií]n(?:imo)?|Min(?:imal)?)(?![\\w])",
  medium: "^\\s*(?:M[ée]dio|Medium)(?![\\w])",
  max: "^\\s*(?:M[áa]x(?:imo)?|Max(?:imum)?)(?![\\w])",
};

/**
 * Set the reasoning level through the model-picker menu, or throw
 * `GeminiWebModelSelectionError`. Skips the menu when the button already shows the level and
 * opens it itself otherwise. Verified against the level the button shows afterwards.
 */
export async function selectGeminiWebReasoning(
  page: GeminiWebPickerPage,
  level: GeminiWebReasoningLevel,
  timeoutMs = 6_000
): Promise<void> {
  const known = [...GEMINI_WEB_PICKER_LABELS];

  // A model pick closes the menu; let that settle before looking at the page.
  await page.waitForTimeout(PICKER_POLL_MS);
  const current = await runPageScript<PickerState | null>(page, TAG_PICKER_SCRIPT, known);
  if (current?.signedOut) throw signedOutError();
  if (pickerLevel(current) === level) return;

  // Reopen the menu unless the section is already on screen.
  if (!(await runPageScript<ItemState>(page, TAG_ITEM_SCRIPT, REASONING_SECTION_PATTERN)).found) {
    if (!current) {
      throw new GeminiWebModelSelectionError(
        502,
        "Gemini Web: the model picker was not found, so the reasoning level cannot be set."
      );
    }
    await clickTagged(
      page,
      PICKER_ATTR,
      "the model picker",
      async () => !!(await runPageScript<PickerState | null>(page, TAG_PICKER_SCRIPT, known))
    );
  }
  const section = await pollItem(page, REASONING_SECTION_PATTERN, timeoutMs);
  if (!section.found) {
    throw new GeminiWebModelSelectionError(
      502,
      "Gemini Web: the reasoning-level control was not found in the model picker " +
        "(the web app may have changed, or this model has no reasoning levels)."
    );
  }
  await clickTagged(
    page,
    ITEM_ATTR,
    "the reasoning-level section",
    async () =>
      (await runPageScript<ItemState>(page, TAG_ITEM_SCRIPT, REASONING_SECTION_PATTERN)).found
  );

  const entry = await pollItem(page, REASONING_LEVEL_PATTERNS[level], timeoutMs);
  if (!entry.found || entry.disabled) {
    throw new GeminiWebModelSelectionError(
      502,
      `Gemini Web: reasoning level "${level}" is not selectable in the model picker.`
    );
  }
  await clickTagged(
    page,
    ITEM_ATTR,
    `the "${level}" reasoning level`,
    async () =>
      (await runPageScript<ItemState>(page, TAG_ITEM_SCRIPT, REASONING_LEVEL_PATTERNS[level])).found
  );

  // The button shows the level once applied ("Argon Médio"). A different level is a failure;
  // a button that shows none cannot be checked, so the click is trusted.
  let shown: GeminiWebReasoningLevel | null = null;
  for (let waited = 0; waited <= 3_000; waited += PICKER_POLL_MS) {
    await page.waitForTimeout(PICKER_POLL_MS);
    shown = pickerLevel(await runPageScript<PickerState | null>(page, TAG_PICKER_SCRIPT, known));
    if (shown === level) return;
  }
  if (shown !== null) {
    throw new GeminiWebModelSelectionError(
      502,
      `Gemini Web: setting reasoning level "${level}" did not take effect (the picker shows "${shown}").`
    );
  }
}
