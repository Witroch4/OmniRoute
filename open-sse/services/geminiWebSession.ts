/**
 * Gemini Web session upkeep — the pure half (no DB, no Playwright).
 *
 * A signed-in gemini.google.com session lives on a ROTATING cookie: `__Secure-1PSIDTS` (plus its
 * 3P twin and the `SIDCC` family) has to be re-minted through
 * `accounts.google.com/RotateCookies` every few minutes. A real browser does it from a hidden
 * iframe. This executor opens a fresh one-shot Chromium per request and the stored header never
 * changed, so a pasted cookie aged out within minutes and the page came back signed-out.
 *
 * What lives here: the cookie-header jar, `Set-Cookie` merging, the Playwright cookie mapping and
 * the RotateCookies call. Who persists the result and when is `src/lib/geminiWebSessionKeeper.ts`.
 */

import { normalizeGeminiCookieInput } from "../utils/geminiCookies.ts";

// ─── Cookie jar ─────────────────────────────────────────────────────────────

export interface CookiePair {
  name: string;
  value: string;
}

/** A change to apply to a stored header: `value: null` removes the cookie. */
export interface CookieUpdate {
  name: string;
  value: string | null;
}

/** Names that are `Cookie` header noise when someone pastes a `Set-Cookie` line. */
const COOKIE_ATTRIBUTE_NAMES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "secure",
  "httponly",
  "samesite",
]);

/**
 * Parse a `Cookie` header (or a `name=value; name2=value2` paste), dropping cookie attributes
 * such as Path/Domain/Expires.
 */
export function parseCookieHeader(raw: string): CookiePair[] {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return null;
      const name = part.substring(0, eqIdx).trim();
      const value = part.substring(eqIdx + 1).trim();
      if (!name || !value) return null;
      if (COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) return null;
      return { name, value };
    })
    .filter(Boolean) as CookiePair[];
}

export function serializeCookieHeader(pairs: readonly CookiePair[]): string {
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/**
 * Apply updates to a stored header, keeping the original order. A cookie that is not in the
 * header yet is appended; a `null` value removes it. `changed` lists the names whose stored
 * value actually differs afterwards (so an identical rotation is a no-op).
 */
export function applyCookieUpdates(
  header: string,
  updates: readonly CookieUpdate[]
): { header: string; changed: string[] } {
  const pairs = parseCookieHeader(header);
  const changed = new Set<string>();

  for (const update of updates) {
    const index = pairs.findIndex((pair) => pair.name === update.name);
    if (update.value === null) {
      if (index !== -1) {
        pairs.splice(index, 1);
        changed.add(update.name);
      }
    } else if (index === -1) {
      pairs.push({ name: update.name, value: update.value });
      changed.add(update.name);
    } else if (pairs[index].value !== update.value) {
      pairs[index] = { name: update.name, value: update.value };
      changed.add(update.name);
    }
  }

  return { header: serializeCookieHeader(pairs), changed: [...changed] };
}

/**
 * Read one `Set-Cookie` line as an update. A cookie the server expires (`Max-Age<=0`, a past
 * `Expires`, or an empty value) is a removal.
 */
export function parseSetCookie(line: string, now: number = Date.now()): CookieUpdate | null {
  const [first, ...attributes] = line.split(";").map((part) => part.trim());
  const eqIdx = first.indexOf("=");
  if (eqIdx <= 0) return null;
  const name = first.substring(0, eqIdx).trim();
  const value = first.substring(eqIdx + 1).trim();

  let expired = value === "";
  for (const attribute of attributes) {
    const sep = attribute.indexOf("=");
    const key = (sep === -1 ? attribute : attribute.substring(0, sep)).trim().toLowerCase();
    const raw = sep === -1 ? "" : attribute.substring(sep + 1).trim();
    if (key === "max-age") {
      const seconds = Number.parseInt(raw, 10);
      if (Number.isFinite(seconds) && seconds <= 0) expired = true;
    } else if (key === "expires") {
      const at = Date.parse(raw);
      if (Number.isFinite(at) && at <= now) expired = true;
    }
  }
  return { name, value: expired ? null : value };
}

export function parseSetCookies(
  lines: readonly string[],
  now: number = Date.now()
): CookieUpdate[] {
  return lines.map((line) => parseSetCookie(line, now)).filter(Boolean) as CookieUpdate[];
}

// ─── Credential → header ────────────────────────────────────────────────────

function readString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readProviderSpecificString(providerSpecificData: unknown, key: string): string {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  ) {
    return "";
  }
  return readString((providerSpecificData as Record<string, unknown>)[key]);
}

// 3.8.53 sync: upstream's normalizer also accepts a browser cookie-export JSON (#11554), so the
// executor, the keeper and the connection test all read a pasted export the same way.
function normalizeCookieInput(raw: string, cookieName = "__Secure-1PSID"): string {
  return normalizeGeminiCookieInput(raw, cookieName);
}

/**
 * The `Cookie` header a Gemini Web connection resolves to. Same precedence the executor has
 * always had: a direct apiKey/cookie, then `providerSpecificData.cookie`, then the bare
 * `__Secure-1PSID` / `__Secure-1PSIDTS` pair.
 */
export function resolveGeminiWebCookieHeader(credentials?: {
  apiKey?: unknown;
  cookie?: unknown;
  providerSpecificData?: unknown;
}): string {
  const direct = readString(credentials?.apiKey) || readString(credentials?.cookie);
  if (direct) return normalizeCookieInput(direct);

  const data = credentials?.providerSpecificData;
  const cookie = readProviderSpecificString(data, "cookie");
  if (cookie) return normalizeCookieInput(cookie);

  const psid = readProviderSpecificString(data, "__Secure-1PSID");
  const psidts = readProviderSpecificString(data, "__Secure-1PSIDTS");
  return [
    psid ? normalizeCookieInput(psid, "__Secure-1PSID") : "",
    psidts ? normalizeCookieInput(psidts, "__Secure-1PSIDTS") : "",
  ]
    .filter(Boolean)
    .join("; ");
}

// ─── Playwright mapping ─────────────────────────────────────────────────────

export interface PlaywrightCookieInput {
  name: string;
  value: string;
  secure: true;
  domain?: string;
  path?: string;
  url?: string;
}

const ACCOUNTS_ORIGIN = "https://accounts.google.com/";

/**
 * Map header pairs to `context.addCookies` input.
 *
 * ⚠️ A `__Host-` cookie may not carry a Domain, and Chromium rejects the WHOLE `addCookies` batch
 * (`Storage.setCookies: Invalid cookie fields`) if even one does. The full header copied from
 * `accounts.google.com/RotateCookies` carries `__Host-1PLSID`, `__Host-3PLSID` and `__Host-GAPS`,
 * which are host-only accounts.google.com cookies — so they go in by URL, everything else stays
 * on `.google.com`.
 */
export function toPlaywrightCookies(pairs: readonly CookiePair[]): PlaywrightCookieInput[] {
  return pairs.map(({ name, value }) =>
    name.startsWith("__Host-")
      ? { name, value, url: ACCOUNTS_ORIGIN, secure: true }
      : { name, value, domain: ".google.com", path: "/", secure: true }
  );
}

/** The cookies Google re-mints during a session; they are worth keeping even when new to us. */
const ROTATING_COOKIE = /^(?:__Secure-[13]PSID(?:TS|CC)|SIDCC)$/;

const GOOGLE_DOMAIN = /(^|\.)google\.com$/i;

/**
 * Compare the browser's jar after a page session with the header it started from and return
 * what Google changed: any cookie we already held whose value moved, plus the rotating family
 * even when it was absent. Unrelated new cookies (tracking, prefs) are deliberately ignored so
 * the stored header cannot grow without bound.
 */
export function collectCookieUpdates(
  sent: readonly CookiePair[],
  jar: ReadonlyArray<{ name: string; value: string; domain?: string }>
): CookieUpdate[] {
  const sentByName = new Map(sent.map((pair) => [pair.name, pair.value]));
  const latest = new Map<string, string>();

  for (const cookie of jar) {
    if (!cookie.name || !cookie.value) continue;
    if (cookie.domain && !GOOGLE_DOMAIN.test(cookie.domain.replace(/^\./, ""))) continue;
    latest.set(cookie.name, cookie.value);
  }

  const updates: CookieUpdate[] = [];
  for (const [name, value] of latest) {
    const before = sentByName.get(name);
    if (before !== undefined ? before !== value : ROTATING_COOKIE.test(name)) {
      updates.push({ name, value });
    }
  }
  return updates;
}

// ─── RotateCookies ──────────────────────────────────────────────────────────

export const GEMINI_WEB_ROTATE_URL = "https://accounts.google.com/RotateCookies";

// The body gemini-webapi has used since it learned to rotate; the value is not validated.
const ROTATE_BODY = '[000,"-0000000000000000000"]';

const ROTATE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export type GeminiWebRotateOutcome =
  /** Google re-minted cookies: `updates` are the deltas, `cookie` the input header with them applied. */
  | { status: "rotated"; cookie: string; updates: CookieUpdate[]; changed: string[] }
  /** 200 with nothing new (asked too soon, or already fresh). */
  | { status: "unchanged"; cookie: string }
  /** 401: Google no longer accepts this session — a fresh login/paste is the only fix. */
  | { status: "unauthorized"; httpStatus: number }
  /** Network failure, 429/5xx, a redirect to the captcha page: try again later. */
  | { status: "error"; httpStatus?: number; message: string };

export interface RotateOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * One `RotateCookies` round-trip with the stored header. Never throws.
 *
 * The full header goes along (accounts-domain cookies included): with only `.google.com`
 * cookies the endpoint answered 401 for a session that was alive in the browser.
 */
export async function rotateGeminiWebCookies(
  cookieHeader: string,
  options: RotateOptions = {}
): Promise<GeminiWebRotateOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchImpl(GEMINI_WEB_ROTATE_URL, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "User-Agent": options.userAgent ?? ROTATE_USER_AGENT,
        Accept: "*/*",
        Origin: "https://accounts.google.com",
        Referer:
          "https://accounts.google.com/RotateCookiesPage?og_pid=658&rot=3&origin=https%3A%2F%2Fgemini.google.com&exp_id=0",
      },
      body: ROTATE_BODY,
    });
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }

  if (response.status === 401) return { status: "unauthorized", httpStatus: 401 };
  if (response.status !== 200) {
    return {
      status: "error",
      httpStatus: response.status,
      message: `RotateCookies answered HTTP ${response.status}`,
    };
  }

  const setCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const updates = parseSetCookies(setCookies);
  const applied = applyCookieUpdates(cookieHeader, updates);
  if (applied.changed.length === 0) return { status: "unchanged", cookie: cookieHeader };
  return { status: "rotated", cookie: applied.header, updates, changed: applied.changed };
}
