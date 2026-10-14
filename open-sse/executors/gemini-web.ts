/**
 * GeminiWebExecutor — Gemini Web Session Provider
 *
 * Routes requests through Google Gemini's web interface using browser
 * cookies + Playwright automation. Translates between OpenAI chat
 * completions format and Gemini's web UI.
 *
 * Auth: Cookie-based (__Secure-1PSID + __Secure-1PSIDTS from gemini.google.com)
 * Method: Playwright browser automation
 *
 * Note: Streaming is pseudo-streaming — waits for full Gemini response then
 * sends as single SSE chunk. Gemini's StreamGenerate endpoint returns complete
 * responses, not chunked streams.
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import {
  findGeminiWebModel,
  GEMINI_WEB_MODELS,
  GEMINI_WEB_PICKER_LABELS,
  type GeminiWebModel,
  type GeminiWebReasoningLevel,
} from "../config/providers/registry/gemini/web/models.ts";
import {
  GeminiWebGateError,
  geminiWebAccountKey,
  getGeminiWebGate,
  type GeminiWebPermit,
} from "../services/geminiWebGate.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/app";

/**
 * Whether an error came from Playwright failing to launch because the browser binary is not
 * installed (`chromium.launch: Executable doesn't exist at ...`). This is a host/config
 * problem, not a transient upstream fault, so the executor must NOT surface it as a retryable
 * 500 (which marks the account unavailable and loops / trips the provider breaker). See #3516.
 */
export function isMissingBrowserExecutable(message: string): boolean {
  if (!message) return false;
  return /executable doesn't exist|executablenotfound|playwright install|chromium.*download/i.test(
    message
  );
}
/** Max wait for the StreamGenerate reply after sending (`GEMINI_WEB_RESPONSE_TIMEOUT_MS`). */
function geminiWebResponseTimeoutMs(): number {
  const raw = Number.parseInt(process.env.GEMINI_WEB_RESPONSE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 120_000;
}

const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ─── Types ──────────────────────────────────────────────────────────────────

interface GeminiMessage {
  role: string;
  content: string;
}

interface GeminiRequestBody {
  messages: GeminiMessage[];
  model?: string;
  stream?: boolean;
  /** OpenAI chat-completions reasoning knob. */
  reasoning_effort?: string;
  /** OpenAI responses-style reasoning knob. */
  reasoning?: { effort?: string };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatChatCompletion(content: string, model: string, finishReason = "stop") {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function formatStreamChunk(content: string, model: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

/**
 * Parse cookie string, stripping attributes (Path, Domain, Expires, etc.)
 * Input: full browser cookie string or just "name=value; name2=value2"
 * Output: array of { name, value } pairs
 */
function parseCookies(raw: string): Array<{ name: string; value: string }> {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return null;
      const name = part.substring(0, eqIdx).trim();
      const value = part.substring(eqIdx + 1).trim();
      // Skip cookie attributes that aren't name=value pairs
      if (!name || !value) return null;
      const lowerName = name.toLowerCase();
      if (
        ["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(
          lowerName
        )
      ) {
        return null;
      }
      return { name, value };
    })
    .filter(Boolean) as Array<{ name: string; value: string }>;
}

/**
 * Parse Gemini StreamGenerate response text.
 *
 * Response format:
 *   )]}'
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *
 * The JSON string contains a nested array: inner[4][0][1] = ["text chunks"].
 *
 * ⚠️ Measured live 2026-10-14: the frames are CUMULATIVE snapshots, not deltas — a 6-word
 * answer arrived as "Um, dois," → "Um, dois, três, quatro, cinco, seis." (repeated), and a
 * one-word answer as "ok" three times. Concatenating them (what this function used to do)
 * returned "okokok". So a frame that extends or repeats what we have REPLACES it; only a frame
 * that is unrelated to it (a genuine delta stream) is appended.
 */
export function parseStreamResponse(raw: string): string {
  const lines = raw.split("\n");
  let current = "";
  let sawSnapshot = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      // Defensive: check each level before accessing
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c: unknown) => typeof c === "string").join("");
      if (!text) continue;

      if (text.startsWith(current)) {
        // Snapshot that extends (or repeats) what we have.
        if (current) sawSnapshot = true;
        current = text;
      } else if (current.startsWith(text)) {
        // An older/shorter snapshot arriving late: keep the longer one.
        sawSnapshot = true;
      } else if (sawSnapshot) {
        // The stream has been snapshots so far and this one is not a prefix relative: the model
        // rewrote its answer, so the newest snapshot wins.
        current = text;
      } else {
        // Unrelated frames and no snapshots seen: a delta stream, append.
        current += text;
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return current;
}

function readCredentialString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readProviderSpecificString(
  providerSpecificData: unknown,
  keys: readonly string[]
): string {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  ) {
    return "";
  }
  const data = providerSpecificData as Record<string, unknown>;
  for (const key of keys) {
    const value = readCredentialString(data[key]);
    if (value) return value;
  }
  return "";
}

function normalizeGeminiCookieInput(raw: string, cookieName = "__Secure-1PSID"): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}

function resolveGeminiWebCookie(credentials: ExecuteInput["credentials"]): string {
  const directCookie =
    readCredentialString(credentials?.apiKey) ||
    readCredentialString((credentials as Record<string, unknown> | undefined)?.cookie);
  if (directCookie) return normalizeGeminiCookieInput(directCookie);

  const providerSpecificData = credentials?.providerSpecificData;
  const cookie = readProviderSpecificString(providerSpecificData, ["cookie"]);
  if (cookie) return normalizeGeminiCookieInput(cookie);

  const psid = readProviderSpecificString(providerSpecificData, ["__Secure-1PSID"]);
  const psidts = readProviderSpecificString(providerSpecificData, ["__Secure-1PSIDTS"]);
  return [
    psid ? normalizeGeminiCookieInput(psid, "__Secure-1PSID") : "",
    psidts ? normalizeGeminiCookieInput(psidts, "__Secure-1PSIDTS") : "",
  ]
    .filter(Boolean)
    .join("; ");
}

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
// not sit on Playwright's 30 s actionability wait.
const CLICK_TIMEOUT_MS = 8_000;

// Finds the picker button (by its aria-label, which is localized — or by its visible model name
// as a fallback), tags it, and reports what it shows and whether the page is signed out.
const TAG_PICKER_SCRIPT = `(known) => {
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  document.querySelectorAll("[${PICKER_ATTR}]").forEach((el) => el.removeAttribute("${PICKER_ATTR}"));
  const ariaRe = /seletor de modo|mode picker|model picker|selecionar modelo|choose.{0,12}model/i;
  const signInRe = /^(sign in|fazer login|entrar|iniciar sess[aã]o|iniciar sesi[oó]n)$/i;
  const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
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

async function clickTagged(page: GeminiWebPickerPage, attr: string, what: string): Promise<void> {
  try {
    await page.locator(`[${attr}]`).first().click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : "unknown";
    throw new GeminiWebModelSelectionError(
      502,
      `Gemini Web: could not click ${what} in the model picker (${reason}).`
    );
  }
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

  await clickTagged(page, PICKER_ATTR, "the model picker");

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
  await clickTagged(page, ITEM_ATTR, `the "${model.uiLabel}" entry`);

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
    await clickTagged(page, PICKER_ATTR, "the model picker");
  }
  const section = await pollItem(page, REASONING_SECTION_PATTERN, timeoutMs);
  if (!section.found) {
    throw new GeminiWebModelSelectionError(
      502,
      "Gemini Web: the reasoning-level control was not found in the model picker " +
        "(the web app may have changed, or this model has no reasoning levels)."
    );
  }
  await clickTagged(page, ITEM_ATTR, "the reasoning-level section");

  const entry = await pollItem(page, REASONING_LEVEL_PATTERNS[level], timeoutMs);
  if (!entry.found || entry.disabled) {
    throw new GeminiWebModelSelectionError(
      502,
      `Gemini Web: reasoning level "${level}" is not selectable in the model picker.`
    );
  }
  await clickTagged(page, ITEM_ATTR, `the "${level}" reasoning level`);

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

// ─── Gate / challenge helpers ───────────────────────────────────────────────

/** Google's "unusual traffic" interstitial (`google.com/sorry/index`, served with HTTP 429). */
export function isGoogleChallengeUrl(url: string): boolean {
  return /(^|\/\/)(www\.)?google\.[a-z.]+\/sorry\//i.test(url);
}

function jsonErrorResponse(
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function gateErrorResponse(err: GeminiWebGateError): Response {
  return jsonErrorResponse(err.status, err.message, {
    "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)),
  });
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal } = input;
    const requestBody = body as GeminiRequestBody;

    const cookie = resolveGeminiWebCookie(credentials);
    if (!cookie) {
      return {
        response: new Response(JSON.stringify({ error: "Missing Gemini cookies" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = requestBody.messages || [];
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    const prompt = lastUserMsg?.content || "";

    if (!prompt) {
      return {
        response: new Response(JSON.stringify({ error: "No user message found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Resolve the requested model BEFORE spending a browser: an id the picker cannot select
    // must fail loudly here, not be answered by whichever model the account defaults to.
    let selectedModel: GeminiWebModel | undefined;
    if (model) {
      selectedModel = findGeminiWebModel(model);
      if (!selectedModel) {
        return {
          response: jsonErrorResponse(
            400,
            `Unknown Gemini Web model "${model}". Available: ` +
              `${GEMINI_WEB_MODELS.map((m) => m.id).join(", ")}.`
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
    }

    const gate = getGeminiWebGate();
    let permit: GeminiWebPermit | null = null;
    let browser: any = null;
    let abortBrowser: (() => void) | null = null;
    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      // Serialize/pace per account and cap concurrent Chromium sessions (see geminiWebGate.ts).
      // Rejections are 429 + Retry-After; they never reach Google.
      permit = await gate.acquire(geminiWebAccountKey(cookie), signal);

      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      abortBrowser = () => {
        void browser?.close().catch(() => {});
      };
      signal?.addEventListener("abort", abortBrowser, { once: true });

      const context = await browser.newContext({ userAgent: GEMINI_USER_AGENT });

      // Parse cookies — strips attributes like Path, Domain, Expires
      const cookiePairs = parseCookies(cookie);
      await context.addCookies(
        cookiePairs.map(({ name, value }) => ({
          name,
          value,
          domain: ".google.com",
          path: "/",
          secure: true,
        }))
      );

      const page = await context.newPage();

      // Capture first StreamGenerate response
      let responseText = "";
      let captured = false;
      let upstreamChallenged = false;
      const responsePromise = new Promise<void>((resolve) => {
        page.on("response", async (resp: any) => {
          if (captured || !resp.url().includes("StreamGenerate")) return;
          captured = true;
          if (typeof resp.status === "function" && resp.status() === 429) {
            upstreamChallenged = true;
            resolve();
            return;
          }
          try {
            const raw = await resp.text();
            responseText = parseStreamResponse(raw);
          } catch {
            /* ignore */
          }
          resolve();
        });
      });

      const navigation = await page.goto(GEMINI_URL, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      // Google answers an automated-looking burst with google.com/sorry (HTTP 429 + reCAPTCHA).
      // Stop everything for the cooldown instead of typing into a captcha page.
      const landedUrl = typeof page.url === "function" ? String(page.url()) : "";
      const navStatus =
        navigation && typeof navigation.status === "function" ? navigation.status() : 0;
      if (isGoogleChallengeUrl(landedUrl) || navStatus === 429) {
        return this.challengeResult(gate, body);
      }
      await page.waitForTimeout(3000);

      // The page answers with whatever model its picker shows; make it the requested one.
      if (selectedModel) {
        await selectGeminiWebModel(page, selectedModel);
      }
      // A tier id (`…-high`) pins the level; `reasoning_effort` only applies to a bare id.
      const reasoning =
        selectedModel?.reasoning ??
        resolveGeminiWebReasoning(requestBody.reasoning_effort ?? requestBody.reasoning?.effort);
      if (reasoning) {
        await selectGeminiWebReasoning(page, reasoning);
      }

      // Type and send message
      const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
        timeout: 10000,
      });
      await inputEl.click();
      await page.keyboard.type(prompt, { delay: 10 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");

      // Wait for the response. Gemini's "thinking" answers regularly take longer than the 30 s
      // this used to cap the whole generation at (a slow reply became a 502 while Google was
      // still answering — measured 15–96 s for "thinking" answers), so it is configurable and
      // defaults to 120 s.
      await Promise.race([responsePromise, page.waitForTimeout(geminiWebResponseTimeoutMs())]);
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }

      const finalUrl = typeof page.url === "function" ? String(page.url()) : "";
      if (upstreamChallenged || isGoogleChallengeUrl(finalUrl)) {
        return this.challengeResult(gate, body);
      }

      if (!responseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      const modelId = selectedModel?.id ?? (model || "gemini-web");

      if (stream) {
        // Pseudo-streaming: send complete response as single SSE chunk
        // Gemini's StreamGenerate returns complete responses, not chunked streams
        const encoder = new TextEncoder();
        const readable = new ReadableStream(
          {
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk(responseText, modelId))}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          },
          { highWaterMark: 16384 }
        );
        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      return {
        response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } catch (error) {
      if (error instanceof GeminiWebGateError) {
        return {
          response: gateErrorResponse(error),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      if (error instanceof GeminiWebModelSelectionError) {
        return {
          response:
            error.status === 400
              ? new Response(
                  JSON.stringify({
                    error: {
                      message: error.message,
                      type: "invalid_request_error",
                      code: "model_not_found",
                    },
                  }),
                  { status: 400, headers: { "Content-Type": "application/json" } }
                )
              : jsonErrorResponse(error.status, error.message),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      // #3516: a missing Playwright browser is a host/config problem, not a transient upstream
      // fault. Surface an actionable error and tag it with the connection-cooldown hint so
      // accountFallback skips the provider circuit breaker and applies a short, non-exponential
      // cooldown instead of looping on a retryable 500.
      if (isMissingBrowserExecutable(rawMessage)) {
        return {
          response: new Response(
            JSON.stringify({
              error:
                "Gemini Web requires the Playwright Chromium browser, which is not installed. " +
                "Run `npx playwright install chromium` on the host (or rebuild the Docker image with browsers).",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown",
              },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      return {
        response: new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(rawMessage),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } finally {
      if (abortBrowser) signal?.removeEventListener("abort", abortBrowser);
      // Always close browser to prevent resource leaks
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore close errors */
        }
      }
      // Only after Chromium is gone, so the browser cap really bounds live processes.
      permit?.release();
    }
  }

  /** Google challenged us: trip the global cooldown and answer 429 + Retry-After. */
  private challengeResult(gate: ReturnType<typeof getGeminiWebGate>, body: unknown) {
    gate.tripChallengeCooldown("google.com/sorry");
    const remaining = gate.challengeRemainingMs();
    return {
      response: gateErrorResponse(
        new GeminiWebGateError(
          "upstream_challenge",
          "Gemini Web: Google served an unusual-traffic challenge (google.com/sorry) for this " +
            "session. Requests are paused so the session is not hammered while flagged — solve " +
            "the captcha at gemini.google.com from the same network, or wait for the cooldown.",
          remaining
        )
      ),
      url: GEMINI_URL,
      headers: {},
      transformedBody: body,
    };
  }
}
