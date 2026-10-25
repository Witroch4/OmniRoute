/**
 * Send every request that presents itself as the official agy CLI through the Go
 * egress (docker/agy-egress), so the connection Google sees is built by Go's net/http
 * like the CLI's own — not by Node's fetch.
 *
 * Why (capture 2026-10-25, agy 1.4.7 vs OmniRoute through the same local TLS proxy):
 * the CLI's ClientHello carries no ALPN (HTTP/1.1) and Go's TLS defaults; its requests
 * are `Host, User-Agent, Content-Length|Transfer-Encoding: chunked, Authorization,
 * Content-Type, Accept-Encoding: gzip`. Node's fetch offers h2, sends an OpenSSL
 * ClientHello and adds `connection: keep-alive`, `accept: *\/*`, `accept-language: *` and
 * `sec-fetch-mode: cors` — none of which can be removed from Node. The egress built with
 * Go 1.27 matched the CLI's ClientHello (JA3, groups, signature algorithms) and header
 * layout exactly in that capture.
 *
 * What is routed: requests whose User-Agent is the CLI identity OmniRoute builds for
 * the `cli` client profile — `antigravity/cli/...` to the Cloud Code hosts, and the
 * CLI's Go OAuth client (`Go-http-client/1.1`) to oauth2/www.googleapis.com. Nothing
 * else: the gemini-cli provider also talks to cloudcode-pa and oauth2, with its own
 * (Node) identity, and stays on Node. The legacy `ide` profile stays on Node too.
 *
 * Enabled by ANTIGRAVITY_EGRESS_URL (e.g. http://omniroute-agy-egress:8787). When set,
 * the egress is mandatory for those requests: if it is down they fail instead of
 * silently going out with Node's fingerprint.
 *
 * Installed once at boot (instrumentation-node), right after the proxy fetch patch and
 * before any request: the provider-request capture wrapper re-wraps the global fetch
 * whenever it is not outermost and shares its inner reference across installs, so a
 * wrapper installed after it would loop — installAntigravityEgressFetch refuses then.
 */

import { ANTIGRAVITY_CLI_OAUTH_USER_AGENT } from "../config/antigravityCliClient.ts";

const CLOUD_CODE_HOSTS: ReadonlySet<string> = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
]);
const OAUTH_HOSTS: ReadonlySet<string> = new Set(["oauth2.googleapis.com", "www.googleapis.com"]);
const CLI_USER_AGENT_PREFIX = "antigravity/cli/";

export const ANTIGRAVITY_EGRESS_HOST_HEADER = "X-Agy-Egress-Host";
export const ANTIGRAVITY_EGRESS_TOKEN_HEADER = "X-Agy-Egress-Token";

const INSTALLED_KEY = Symbol.for("omniroute.antigravityEgressFetch.installed");
const CAPTURE_STATE_KEY = Symbol.for("omniroute.providerRequestCapture.state");

export type AntigravityEgressConfig = { baseUrl: string; token: string | null };

export function getAntigravityEgressConfig(
  env: Record<string, string | undefined> = process.env
): AntigravityEgressConfig | null {
  const raw = env.ANTIGRAVITY_EGRESS_URL?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const token = env.ANTIGRAVITY_EGRESS_TOKEN?.trim() || null;
  return { baseUrl: raw.replace(/\/+$/, ""), token };
}

/** True for a request OmniRoute built as the official agy CLI (`cli` profile). */
export function isAntigravityCliRequest(url: URL, headers: Headers): boolean {
  const userAgent = headers.get("user-agent") ?? "";
  if (CLOUD_CODE_HOSTS.has(url.hostname)) return userAgent.startsWith(CLI_USER_AGENT_PREFIX);
  if (OAUTH_HOSTS.has(url.hostname)) return userAgent === ANTIGRAVITY_CLI_OAUTH_USER_AGENT;
  return false;
}

export function toAntigravityEgressRequest(
  url: URL,
  init: RequestInit | undefined,
  config: AntigravityEgressConfig
): { url: string; init: RequestInit } {
  const headers = new Headers(init?.headers);
  headers.set(ANTIGRAVITY_EGRESS_HOST_HEADER, url.hostname);
  if (config.token) headers.set(ANTIGRAVITY_EGRESS_TOKEN_HEADER, config.token);
  return {
    url: `${config.baseUrl}${url.pathname}${url.search}`,
    init: { ...init, headers },
  };
}

function targetUrl(input: RequestInfo | URL): URL | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : null;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Wrap a fetch so CLI-identity requests go to the egress. Exported for tests. */
export function createAntigravityEgressFetch(
  previous: typeof fetch,
  config: AntigravityEgressConfig
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = targetUrl(input);
    if (url && isAntigravityCliRequest(url, new Headers(init?.headers))) {
      const routed = toAntigravityEgressRequest(url, init, config);
      return previous(routed.url, routed.init);
    }
    return previous(input, init);
  }) as typeof fetch;
}

export type InstallResult = "disabled" | "installed" | "already-installed" | "refused";

export function installAntigravityEgressFetch(
  env: Record<string, string | undefined> = process.env
): InstallResult {
  const config = getAntigravityEgressConfig(env);
  if (!config) return "disabled";
  const scoped = globalThis as typeof globalThis & {
    [INSTALLED_KEY]?: boolean;
    [CAPTURE_STATE_KEY]?: { wrappedFetch?: unknown };
  };
  if (scoped[INSTALLED_KEY]) return "already-installed";
  if (scoped[CAPTURE_STATE_KEY]?.wrappedFetch) {
    console.error(
      "[AGY_EGRESS] Not installed: the provider-request capture already wraps fetch; " +
        "installing after it would loop. Install at boot, before any provider request."
    );
    return "refused";
  }
  globalThis.fetch = createAntigravityEgressFetch(globalThis.fetch, config);
  scoped[INSTALLED_KEY] = true;
  return "installed";
}

/** @internal test helper */
export function resetAntigravityEgressInstallForTests(): void {
  delete (globalThis as typeof globalThis & { [INSTALLED_KEY]?: boolean })[INSTALLED_KEY];
}
