// Impersonated Codex CLI version sent on every OM->OpenAI Codex request (the
// `Version` header + User-Agent). OpenAI gates some newer models behind a
// minimum declared CLI version server-side — a stale value here produces a
// 400 "The '<model>' model requires a newer version of Codex" for EVERY
// request to that model, regardless of prompt/effort/tools, which looks like
// a model-capability problem but is purely this string being out of date.
// Bump to match https://www.npmjs.com/package/@openai/codex when a new
// model launch starts rejecting with that exact message (verified stale
// 2026-08-29: real latest was 0.151.0, this lineage was on 0.144.1, which
// root-caused the gpt-5.6-luna/terra/sol 400s). Production had been running
// the fixed value via the CODEX_CLIENT_VERSION env override since then; this
// makes the image itself carry it, so the override is no longer load-bearing.
// 2026-09-03: 0.151.0 -> 0.153.0 (current npm release), bumped alongside the
// claude-cli pin so the two impersonated CLIs do not drift apart again.
// ⚠️ UNVERIFIED against the live upstream: every Codex model was returning 429
// from the quota preflight (reset ~89h) when this shipped, so no call reaches
// OpenAI to confirm the new version is accepted. Nothing was BLOCKED by the old
// value either — this is hygiene, not a fix. If Codex starts 400ing after quota
// returns, set CODEX_CLIENT_VERSION=0.151.0 and restart; that is what the
// override is for.
// 2026-09-04: 0.153.0 -> 0.153.4 (current npm release; 0.154.0 is alpha-only),
// bumped because GPT-6 Astra appeared in the picker and is version-gated. A
// probe with production still declaring 0.151.0 returned the exact message this
// comment warns about: "The 'gpt-6-astra' model requires a newer version of
// Codex." That is now the SECOND model launch this string has blocked, so treat
// "a new model 400s the moment it ships" as this value first, entitlement second.
// ⚠️ Still unverified end-to-end: codex quota is exhausted until ~2026-09-26
// (reset 511h), so no call reaches OpenAI. 0.153.4 may or may not be new enough
// for a GPT-6-generation model — if it still 400s once quota returns, check npm
// for a newer release rather than assuming the account lacks entitlement.
const DEFAULT_CODEX_CLIENT_VERSION = "0.153.4";
const DEFAULT_CODEX_USER_AGENT_PLATFORM = "Windows 10.0.26200";
const DEFAULT_CODEX_USER_AGENT_ARCH = "x64";
const CODEX_VERSION_OVERRIDE_ENV = "CODEX_CLIENT_VERSION";
const CODEX_USER_AGENT_OVERRIDE_ENV = "CODEX_USER_AGENT";
const SAFE_HEADER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SAFE_HEADER_VALUE_PATTERN = /^[\x20-\x7E]{1,200}$/;
const SAFE_CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function getSafeEnvValue(name: string, pattern: RegExp): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!normalized || !pattern.test(normalized)) {
    return null;
  }
  return normalized;
}

export function getCodexClientVersion(): string {
  return (
    getSafeEnvValue(CODEX_VERSION_OVERRIDE_ENV, SAFE_HEADER_TOKEN_PATTERN) ||
    DEFAULT_CODEX_CLIENT_VERSION
  );
}

export function getCodexUserAgent(): string {
  const override = getSafeEnvValue(CODEX_USER_AGENT_OVERRIDE_ENV, SAFE_HEADER_VALUE_PATTERN);
  if (override) {
    return override;
  }

  return `codex-cli/${getCodexClientVersion()} (${DEFAULT_CODEX_USER_AGENT_PLATFORM}; ${DEFAULT_CODEX_USER_AGENT_ARCH})`;
}

export function getCodexDefaultHeaders(): Record<string, string> {
  return {
    Version: getCodexClientVersion(),
    "Openai-Beta": "responses=experimental",
    "X-Codex-Beta-Features": "responses_websockets",
    "User-Agent": getCodexUserAgent(),
  };
}

export function normalizeCodexSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SAFE_CODEX_SESSION_ID_PATTERN.test(normalized) ? normalized : null;
}
