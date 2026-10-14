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
  type GeminiWebModel,
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
 * The JSON string contains nested array: inner[4][0][1] = ["text chunks"].
 * We concatenate text from every wrb.fr line because Gemini can split one
 * assistant answer across multiple StreamGenerate chunks.
 */
export function parseStreamResponse(raw: string): string {
  const lines = raw.split("\n");
  const textChunks: string[] = [];

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
      if (text) textChunks.push(text);
    } catch {
      // Skip unparseable lines
    }
  }
  return textChunks.join("");
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
// The web app answers with whatever model its mode picker currently shows (the account
// default, or the last pick). Selecting a model therefore means driving that picker BEFORE
// typing the prompt. The page scripts are plain strings so this file needs no DOM typings
// and a test can run them against a stub `document`.

export class GeminiWebModelSelectionError extends Error {
  /** 404: the account's picker does not offer the model. 502: the picker could not be driven. */
  readonly status: 404 | 502;

  constructor(status: 404 | 502, message: string) {
    super(message);
    this.name = "GeminiWebModelSelectionError";
    this.status = status;
  }
}

/** The slice of Playwright's `Page` the picker needs. */
export interface GeminiWebPickerPage {
  evaluate<R, A>(script: string, arg: A): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): { first(): { click(): Promise<void> } };
}

interface PickerState {
  text: string;
  aria: string;
}

const PICKER_ATTR = "data-omni-gweb-picker";
const ITEM_ATTR = "data-omni-gweb-item";
const PICKER_POLL_MS = 250;

// Finds the picker button (by its visible model name, or by its aria-label — the label is
// localized, so both are accepted), tags it, and reports what it currently shows.
const TAG_PICKER_SCRIPT = `(known) => {
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  document.querySelectorAll("[${PICKER_ATTR}]").forEach((el) => el.removeAttribute("${PICKER_ATTR}"));
  const ariaRe = /seletor de modo|mode picker|model picker|selecionar modelo|choose.{0,12}model/i;
  for (const el of document.querySelectorAll("button, [role='button']")) {
    const text = norm(el.innerText);
    const aria = norm(el.getAttribute("aria-label"));
    if (known.includes(text) || ariaRe.test(aria)) {
      el.setAttribute("${PICKER_ATTR}", "1");
      return { text, aria };
    }
  }
  return null;
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
      return true;
    }
  }
  return false;
}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source matching a menu entry's text for `model` (entries read "3.8 Flash Ajuda para tudo"). */
export function geminiWebMenuItemPattern(model: GeminiWebModel): string {
  // "3.8 Flash" must not select a sibling "3.8 Flash Lite"; "3.1 Pro" must not select "3.1 Pro2".
  const notLite = /\bLite$/i.test(model.uiLabel) ? "" : "(?!\\s+Lite\\b)";
  return `^\\s*${escapeRegExp(model.uiLabel)}(?![\\w.])${notLite}`;
}

function pickerShows(state: PickerState | null, model: GeminiWebModel): boolean {
  if (!state) return false;
  const labels = [model.uiLabel, ...(model.pillLabels ?? [])];
  return labels.some((label) => state.text === label || state.aria.endsWith(label));
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
  const known = GEMINI_WEB_MODELS.flatMap((m) => [m.uiLabel, ...(m.pillLabels ?? [])]);

  let state: PickerState | null = null;
  for (let waited = 0; waited <= timeoutMs; waited += PICKER_POLL_MS) {
    state = await page.evaluate<PickerState | null, string[]>(TAG_PICKER_SCRIPT, known);
    if (state) break;
    await page.waitForTimeout(PICKER_POLL_MS);
  }
  if (!state) {
    throw new GeminiWebModelSelectionError(
      502,
      "Gemini Web: the model picker was not found on the page (the web app may have changed or " +
        "the session is not signed in), so the requested model cannot be selected."
    );
  }
  if (pickerShows(state, model)) return;

  await page.locator(`[${PICKER_ATTR}]`).first().click();

  let found = false;
  for (let waited = 0; waited <= 5_000; waited += PICKER_POLL_MS) {
    found = await page.evaluate<boolean, string>(TAG_ITEM_SCRIPT, geminiWebMenuItemPattern(model));
    if (found) break;
    await page.waitForTimeout(PICKER_POLL_MS);
  }
  if (!found) {
    throw new GeminiWebModelSelectionError(
      404,
      `Gemini Web: model "${model.uiLabel}" is not offered by this account's model picker ` +
        `(plan or staged rollout).`
    );
  }
  await page.locator(`[${ITEM_ATTR}]`).first().click();

  for (let waited = 0; waited <= 4_000; waited += PICKER_POLL_MS) {
    await page.waitForTimeout(PICKER_POLL_MS);
    const after = await page.evaluate<PickerState | null, string[]>(TAG_PICKER_SCRIPT, known);
    if (pickerShows(after, model)) return;
  }
  throw new GeminiWebModelSelectionError(
    502,
    `Gemini Web: selecting "${model.uiLabel}" did not take effect in the model picker.`
  );
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

      // Type and send message
      const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
        timeout: 10000,
      });
      await inputEl.click();
      await page.keyboard.type(prompt, { delay: 10 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");

      // Wait for response or timeout
      await Promise.race([responsePromise, page.waitForTimeout(30000)]);
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
          response: jsonErrorResponse(error.status, error.message),
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
