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
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { isMissingBrowserExecutable } from "./browserExecutableCheck.ts";
import { prepareToolMessages } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import {
  checkGeminiWebUnsupportedControls,
  GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
  isForcingToolChoice,
} from "./gemini-web/capabilities.ts";
// Fork: model + reasoning-level selection is the live-verified picker (geminiWebPicker.ts,
// measured against the real page 2026-10-14) over the fork's 12-id catalog, not upstream's
// gemini-web/modeSelection.ts (#13381, whose selectors were never validated against a live
// account and whose 3-model catalog the fork does not publish).
import {
  findGeminiWebModel,
  GEMINI_WEB_MODELS,
  type GeminiWebModel,
} from "../config/providers/registry/gemini/web/models.ts";
import {
  GeminiWebModelSelectionError,
  resolveGeminiWebReasoning,
  selectGeminiWebModel,
  selectGeminiWebReasoning,
} from "./geminiWebPicker.ts";

export {
  GeminiWebModelSelectionError,
  geminiWebMenuItemPattern,
  resolveGeminiWebReasoning,
  selectGeminiWebModel,
  selectGeminiWebReasoning,
  type GeminiWebPickerPage,
  type GeminiWebReasoningLevel,
} from "./geminiWebPicker.ts";
import {
  GeminiWebGateError,
  geminiWebAccountKey,
  getGeminiWebGate,
  type GeminiWebPermit,
} from "../services/geminiWebGate.ts";
import type { GeminiBrowser } from "./gemini-web/browserLease.ts";
import {
  collectCookieUpdates,
  parseCookieHeader,
  resolveGeminiWebCookieHeader,
  toPlaywrightCookies,
  type CookiePair,
} from "../services/geminiWebSession.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/app";

// Re-exported for backward compatibility: some tests/callers import this classification helper
// from gemini-web.ts, its original home (#3516). The implementation now lives in
// browserExecutableCheck.ts so other browser-backed executors (e.g. zai-web.ts, #13232) can
// share it without importing this whole executor module.
export { isMissingBrowserExecutable } from "./browserExecutableCheck.ts";

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
 * Flatten the OpenAI-style multi-turn `messages[]` into the single plain-text
 * prompt typed into the Gemini web UI (#8371).
 *
 * gemini-web drives a real browser page and captures only the FIRST
 * `StreamGenerate` response, so — unlike claude-web — it has no upstream
 * conversation id to thread across turns. It is therefore a stateless,
 * single-turn provider: the previous code forwarded only the last user message
 * (`messages.filter(m => m.role === "user").pop()`), so follow-up questions
 * lost all prior context ("I am in Berlin" → "What should I wear today?" was
 * answered without Berlin). This implements the issue's accepted fallback (b):
 * flatten the full history into one prompt so the web UI still sees the
 * conversation.
 *
 * Single-turn requests with NO system message are preserved byte-for-byte
 * (only the final user message is returned) — the regression guard for the
 * pre-existing no-tools path. A single-turn request that DOES carry a system
 * message prepends it the same way the multi-turn branch does (#13380 — the
 * old fast path silently dropped the system instruction whenever there was
 * no prior user/assistant turn, e.g. title generation or a one-shot chat
 * completion). Multi-turn requests emit a labeled transcript:
 *
 *   System:
 *   <system text>
 *
 *   Previous conversation:
 *   User: ...
 *   Assistant: ...
 *
 *   Current user message:
 *   <last user message>
 */
export function buildGeminiPrompt(messages: Array<{ role: string; content: unknown }>): string {
  const textMessages = messages.filter(
    (m) => typeof m.content === "string" && (m.content as string).trim().length > 0
  ) as Array<{ role: string; content: string }>;

  const userMessages = textMessages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserContent = lastUser?.content ?? "";
  const lastUserIdx = lastUser ? textMessages.lastIndexOf(lastUser) : -1;

  // Prior conversation = every user/assistant turn before the final user turn.
  const priorTurns = textMessages.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant")
  );

  const systemText = textMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  // Single-turn (no earlier user/assistant turns) with no system message:
  // byte-for-byte the original single-message derivation.
  if (priorTurns.length === 0 && !systemText) return lastUserContent;

  // Single-turn with a system message (#13380): prepend it instead of
  // silently dropping it.
  if (priorTurns.length === 0) return `System:\n${systemText}\n\n${lastUserContent}`;

  const historyLines = priorTurns.map(
    (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`
  );

  const parts: string[] = [];
  if (systemText) parts.push(`System:\n${systemText}`);
  parts.push(`Previous conversation:\n${historyLines.join("\n\n")}`);
  parts.push(`Current user message:\n${lastUserContent}`);
  return parts.join("\n\n");
}

/**
 * Build the plain-text prompt typed into the Gemini web UI when a tool
 * contract is active — every system message (the client's own instruction(s)
 * plus the synthetic tool contract that `prepareToolMessages()` appends last)
 * prepended, in order, to the last user message. gemini-web only ever sends
 * a single flat string (no native message array), so the tool contract and
 * the user's ask are concatenated (#7286).
 *
 * `prepareToolMessages()` (open-sse/translator/webTools.ts) pushes the
 * synthetic tool contract as the LAST system message so it never buries a
 * long client system prompt. Picking only the FIRST system message
 * (`.find()`) therefore dropped the tool contract whenever the client
 * already sent its own system message — #13380. Joining ALL system messages
 * in order keeps the client instruction(s) first and the tool contract last,
 * matching that dual-placement design intent.
 */
export function buildGeminiToolPrompt(
  effectiveMessages: Array<{
    role: string;
    content: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
  }>
): string {
  const toolPrompt = effectiveMessages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n\n");
  const lastUserIdx = effectiveMessages.map((m) => m.role).lastIndexOf("user");
  const lastUserMsg = lastUserIdx >= 0 ? effectiveMessages[lastUserIdx] : undefined;
  const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

  // Everything except the current ask has to be rendered: an assistant turn that
  // called a tool and the `role: "tool"` result for it are the only evidence
  // Gemini Web gets that the tool already ran. Dropping them (this function used
  // to keep only system + last user) made the model re-issue the same call with a
  // fresh id, looping until the client's tool limit stopped it (#14368).
  //
  // The boundary must be the current ask itself, not "everything before it": a
  // tool round usually arrives as `system, user, assistant(tool_calls), tool`
  // with NO message after the result, so slicing at `lastUserIdx` threw away the
  // very turns the fix was for (#14374 review).
  const prior: string[] = [];
  for (const [index, m] of effectiveMessages.entries()) {
    if (index === lastUserIdx) continue; // rendered below as the current ask
    if (typeof m.content === "string" && m.content.trim()) {
      if (m.role === "user") prior.push(`User: ${m.content}`);
      else if (m.role === "assistant") prior.push(`Assistant: ${m.content}`);
      else if (m.role === "tool") {
        const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
        prior.push(id ? `Tool result [${id}]: ${m.content}` : `Tool result: ${m.content}`);
      }
    }
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const entry of calls) {
      const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof call.function?.name === "string" ? call.function.name : "tool";
      const args = typeof call.function?.arguments === "string" ? call.function.arguments : "{}";
      const id = typeof call.id === "string" ? ` [${call.id}]` : "";
      prior.push(`Assistant requested tool${id}: ${name}(${args})`);
    }
  }

  // Single-turn: byte-for-byte the shape #7286 pinned.
  if (prior.length === 0) return toolPrompt ? `${toolPrompt}\n\n${userText}` : userText;

  const parts: string[] = [];
  if (toolPrompt) parts.push(toolPrompt);
  parts.push(`Previous conversation:\n${prior.join("\n\n")}`);
  parts.push(`Current user message:\n${userText}`);
  return parts.join("\n\n");
}

/**
 * Tool mode: wrap the buffered Gemini response text in the standard OpenAI
 * completion shape, then delegate to the shared `buildToolModeResponse()`
 * (`chatgptWebTools.ts`) — parses `<tool>{...}</tool>` blocks out of the
 * text into `tool_calls` (malformed JSON degrades to ordinary `content`,
 * never throws) and replays either buffered JSON or a terminal SSE chunk
 * depending on `stream` (#7286). Exported standalone so the branching logic
 * is testable without a full Playwright mock.
 */
export async function buildGeminiToolResponse(
  responseText: string,
  requestedTools: unknown,
  stream: boolean,
  model: string,
  cid: string,
  created: number
): Promise<Response> {
  const bufferedJson = new Response(JSON.stringify(formatChatCompletion(responseText, model)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  return buildToolModeResponse(bufferedJson, requestedTools, stream, {
    cid,
    created,
    model,
    idSeed: "gwe",
  });
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

/**
 * Send whatever Google rotated during this page session to the connection's stored header.
 * Best effort: a failure here must never turn a good answer into an error.
 */
async function persistRotatedCookiesToKeeper(
  connectionId: string | undefined,
  context: { cookies?: () => Promise<Array<{ name: string; value: string; domain?: string }>> },
  sent: readonly CookiePair[]
): Promise<void> {
  if (!connectionId || typeof context.cookies !== "function") return;
  try {
    const updates = collectCookieUpdates(sent, await context.cookies());
    if (updates.length === 0) return;
    const { applyGeminiWebCookieUpdates } = await import("@/lib/geminiWebSessionKeeper");
    await applyGeminiWebCookieUpdates(connectionId, updates);
  } catch {
    /* best effort */
  }
}

/**
 * Merge rotated __Secure-1PSID* cookies read back from the live Playwright
 * cookie jar into the original cookie string. Only the three long-lived
 * Gemini auth cookies are considered — pulling in the entire jar would risk
 * treating short-lived Google analytics/consent cookies as credentials
 * (#7676). Cookies the jar didn't return, or that are unchanged, are left
 * untouched in the original string.
 */
export function mergeRotatedGeminiCookies(
  originalCookie: string,
  jarCookies: Array<{ name: string; value: string }>
): string {
  const ROTATABLE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"];
  const jarByName = new Map(jarCookies.map((c) => [c.name, c.value]));

  const pairs = parseCookieHeader(originalCookie);
  const seen = new Set<string>();
  const merged = pairs.map(({ name, value }) => {
    seen.add(name);
    if (ROTATABLE_NAMES.includes(name) && jarByName.has(name)) {
      return { name, value: jarByName.get(name) as string };
    }
    return { name, value };
  });

  for (const name of ROTATABLE_NAMES) {
    if (!seen.has(name) && jarByName.has(name)) {
      merged.push({ name, value: jarByName.get(name) as string });
    }
  }

  return merged.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/** The connection's `Cookie` header (fork resolver; accepts bare PSIDs and cookie exports). */
function resolveGeminiWebCookie(credentials: ExecuteInput["credentials"]): string {
  return resolveGeminiWebCookieHeader({
    apiKey: credentials?.apiKey,
    cookie: (credentials as Record<string, unknown> | undefined)?.cookie,
    providerSpecificData: credentials?.providerSpecificData,
  });
}

/**
 * One launcher closure per `chromium.launch` function. browserLease.ts reuses the shared
 * process only while it is handed the SAME launcher; building a new arrow per request made it
 * close the live process (under any concurrent request) and relaunch every time. Keyed on the
 * underlying function so a test that swaps `chromium.launch` still gets its own browser.
 */
type GeminiBrowserLauncher = (options: { headless: true }) => Promise<GeminiBrowser>;
const chromiumLaunchers = new WeakMap<GeminiBrowserLauncher, GeminiBrowserLauncher>();
function stableChromiumLauncher(chromium: {
  launch: GeminiBrowserLauncher;
}): GeminiBrowserLauncher {
  let launcher = chromiumLaunchers.get(chromium.launch);
  if (!launcher) {
    launcher = (options) => chromium.launch(options);
    chromiumLaunchers.set(chromium.launch, launcher);
  }
  return launcher;
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }

  /**
   * testConnection — validates the cookie format without making a network call
   * or launching Playwright. Returns true when the cookie is non-empty and
   * contains at least one name=value pair with a non-empty value. This is a
   * lightweight pre-check before the browser automation path; full session
   * validation is done by validateGeminiWebProvider in the connection test
   * flow (#9407).
   */
  async testConnection(
    credentials: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const cookie = resolveGeminiWebCookie(credentials as unknown as ExecuteInput["credentials"]);
      if (!cookie) return false;
      const pairs = parseCookieHeader(cookie);
      return pairs.some((p) => p.value.length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Read the live Playwright cookie jar back after a successful run and, if
   * Google rotated any of the __Secure-1PSID* cookies, forward the merged
   * cookie string through onCredentialsRefreshed so it gets persisted to the
   * encrypted provider_connections.api_key field. Mirrors the rotate-and-
   * persist pattern used by other rotating-session executors. A persistence failure
   * must never fail the user-facing response (#7676).
   */
  private async persistRotatedCookies(
    context: import("playwright").BrowserContext,
    cookie: string,
    credentials: ExecuteInput["credentials"],
    onCredentialsRefreshed: ExecuteInput["onCredentialsRefreshed"],
    log: ExecuteInput["log"]
  ): Promise<void> {
    if (!onCredentialsRefreshed) return;
    try {
      const jarCookies = await context.cookies();
      const mergedCookie = mergeRotatedGeminiCookies(cookie, jarCookies);
      if (mergedCookie && mergedCookie !== cookie) {
        await onCredentialsRefreshed({ ...credentials, apiKey: mergedCookie });
      }
    } catch (err) {
      log?.warn?.(
        "GEMINI-WEB",
        `Failed to persist rotated cookie: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal, log, onCredentialsRefreshed } = input;
    const requestBody = body as GeminiRequestBody;

    // #9356: forced tool_choice is a guarantee gemini-web's prompt-emulation shim can
    // never make — no UI control for it exists at all, on any account, so this still
    // fails fast before the credential check and before Playwright launches. See
    // ./gemini-web/capabilities.ts.
    //
    // Fork: `reasoning_effort` is not rejected either — the page's picker offers three
    // reasoning levels (Mín./Médio/Máx., measured live 2026-10-14), set below by
    // selectGeminiWebReasoning; a tier id (`…-high`) pins the level by itself.
    const rawBody = body as Record<string, unknown>;
    if (isForcingToolChoice(rawBody.tool_choice)) {
      const violation = checkGeminiWebUnsupportedControls({ tool_choice: rawBody.tool_choice });
      log?.warn?.(
        "GEMINI-WEB",
        `Rejected request: "${violation!.param}" is not supported by this provider`
      );
      return {
        response: new Response(
          JSON.stringify(
            buildErrorBody(400, violation!.message, null, {
              type: "invalid_request_error",
              code: GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
            })
          ),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

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
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      body as Record<string, unknown>,
      messages
    );

    // hasTools === false: flatten the full multi-turn history into the single
    // prompt so gemini-web (a stateless web-cookie provider that captures only
    // the first StreamGenerate response) preserves prior context across turns
    // (#8371). Single-turn requests with no system message stay byte-for-byte
    // identical to the original derivation; a single-turn system message is
    // now prepended instead of silently dropped (#13380).
    const prompt = hasTools
      ? buildGeminiToolPrompt(effectiveMessages)
      : buildGeminiPrompt(messages);

    // A system-only request (no user message at all) must still 400 — since
    // #13380 prepends the system text, `prompt` alone is no longer a
    // reliable "no user message" signal for the no-tools path (it used to be
    // empty for a system-only request; now it carries the system text).
    const hasUserMessage = messages.some(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
    );

    if (!prompt || (!hasTools && !hasUserMessage)) {
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
    const modelId = selectedModel?.id ?? (model || "gemini-web");

    const gate = getGeminiWebGate();
    let permit: GeminiWebPermit | null = null;
    let browser: any = null;
    let context: import("playwright").BrowserContext | null = null;
    let abortBrowser: (() => void) | null = null;
    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      // Serialize/pace per account and cap concurrent Chromium sessions (see geminiWebGate.ts).
      // Rejections are 429 + Retry-After; they never reach Google.
      permit = await gate.acquire(geminiWebAccountKey(cookie), signal);

      const { chromium } = await import("playwright");
      const { acquireGeminiBrowser } = await import("./gemini-web/browserLease.ts");
      // #13382/#14646: one shared Chromium process, a fresh context per request. The lease keys
      // the process on the launcher's identity, so it must be the SAME function across requests
      // (a fresh closure per call relaunched — and closed the process under a concurrent request).
      browser = await acquireGeminiBrowser(stableChromiumLauncher(chromium));
      abortBrowser = () => {
        void context?.close().catch(() => {});
      };
      signal?.addEventListener("abort", abortBrowser, { once: true });

      // #15076: apply the proxy configured for gemini-web (provider/global scope). Resolved per
      // context so the shared leased browser needs no invalidation when the proxy changes.
      const { resolvePlaywrightProxy } = await import("../services/browserPool.ts");
      const proxy = await resolvePlaywrightProxy("gemini-web");
      context = await browser.newContext({
        userAgent: GEMINI_USER_AGENT,
        ...(proxy ? { proxy } : {}),
      });

      // Parse cookies — strips attributes like Path, Domain, Expires. `__Host-` cookies go in by
      // URL: with a Domain Chromium rejects the whole batch (see toPlaywrightCookies).
      const cookiePairs = parseCookieHeader(cookie);
      await context.addCookies(toPlaywrightCookies(cookiePairs));

      const page = await context.newPage();

      // Capture first StreamGenerate response
      let responseText = "";
      let captured = false;
      let upstreamChallenged = false;
      const responsePromise = new Promise<void>((resolve) => {
        page.on("response", async (resp: any) => {
          if (captured || !resp.url().includes("StreamGenerate")) return;
          // Resolve even if reading the body throws, so the flow falls through
          // to the "No response from Gemini" 502 instead of burning the full
          // wait window.
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
      // #13382: the composer selector is the readiness check. A fixed 3s sleep
      // ran even when the editor was already there, and still raced a slow load.
      await page.waitForSelector(".ql-editor, [contenteditable='true']", { timeout: 10000 });

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
      // insertText() dispatches a DOM `input` event atomically instead of a
      // per-character keydown/keypress/keyup sequence (#13380) — an embedded
      // `\n` in `prompt` (produced by the multi-turn transcript format above,
      // or by any multiline system/user text) no longer fires the
      // composer's Enter-submits-the-message handler before this function's
      // own explicit Enter below. It also removes the fixed 10ms/char typing
      // cost that made long prompts race the response-wait timeout.
      await page.keyboard.insertText(prompt);
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

      // The page may have re-minted the session cookies while it was open. The context is
      // closed right after this request, so hand them back or the stored header keeps aging.
      // Fork: a stored connection goes through the session keeper (locked against its own
      // background rotation, every rotated cookie); credentials with no connection id fall
      // back to upstream's onCredentialsRefreshed merge of the three PSID cookies (#7676).
      if (credentials?.connectionId) {
        await persistRotatedCookiesToKeeper(credentials.connectionId, context, cookiePairs);
      } else {
        await this.persistRotatedCookies(context, cookie, credentials, onCredentialsRefreshed, log);
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

      if (hasTools) {
        const cid = `chatcmpl-gwe-${crypto.randomUUID().slice(0, 12)}`;
        const created = Math.floor(Date.now() / 1000);
        const toolResponse = await buildGeminiToolResponse(
          responseText,
          requestedTools,
          Boolean(stream),
          modelId,
          cid,
          created
        );
        return { response: toolResponse, url: GEMINI_URL, headers: {}, transformedBody: body };
      }

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
      // #9407: Playwright selector/click timeout errors are terminal — they indicate
      // the page DOM does not match expectations (e.g. Gemini changed their UI or
      // the session is so expired it lands on a different page). Return 400 so the
      // account-fallback system does NOT retry this request as a transient 5xx.
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          rawMessage.includes("waitForSelector") ||
          rawMessage.includes("Timeout") ||
          rawMessage.includes("actionability") ||
          rawMessage.includes("interception"))
      ) {
        return {
          response: new Response(
            JSON.stringify({
              error: sanitizeErrorMessage(rawMessage),
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
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
      // #13382: close this request's context. The Chromium process stays
      // warm until it has been idle.
      try {
        await context?.close();
      } catch {
        /* ignore close errors */
      }
      if (browser) {
        const { releaseGeminiBrowser } = await import("./gemini-web/browserLease.ts");
        await releaseGeminiBrowser(browser);
      }
      // Only after this request's browser work is done, so the browser cap really bounds
      // live sessions.
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
