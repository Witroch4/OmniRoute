// Impersonated Claude Code CLI version sent on every OM->Anthropic OAuth request
// (the `claude-cli/<version>` User-Agent and the `cc_version=` billing header).
// Anthropic gates newer models behind a minimum declared CLI version
// server-side, so a stale value here produces a 400 like
//   "Claude Code 2.1.207 does not support this model; version 2.1.251 or newer
//    is required. Run 'claude update'"
// for EVERY request to that model, regardless of prompt/tools. It reads as a
// model-availability problem but is purely this string being out of date —
// measured 2026-09-03, when `cc/claude-fable-5-1` 400'd on that exact message
// while `cc/claude-fable-5` and `cc/claude-opus-5` answered normally.
//
// Pinned to 2.1.259, the current published @anthropic-ai/claude-code release
// (2.1.251 is only the floor the error names). Same convention as codexClient:
// track the real latest, not the minimum that happens to unblock one model.
// ⚠️ The bundled-SDK constants (CLAUDE_*_STAINLESS_*) were NOT re-captured:
// the npm package is a 204KB installer wrapper that fetches the real binary, so
// the SDK version is not extractable from it. They stay at the known-good 0.94.0
// rather than being invented; the pairing is verified empirically against the
// live upstream after deploy.
//
// This mirrors `codexClient.ts`, which exists for the identical failure mode on
// the OpenAI side (gpt-5.6-luna/terra/sol). The env override is the reason that
// one is here: it lets production move the declared version without a rebuild,
// which matters because this string is on the hot path of ALL Claude OAuth
// traffic — if a bump is rejected upstream, `CLAUDE_CODE_VERSION=<old>` plus a
// restart is the rollback, instead of an hour-long ARM image build.
const DEFAULT_CLAUDE_CODE_VERSION = "2.1.259";
const CLAUDE_CODE_VERSION_OVERRIDE_ENV = "CLAUDE_CODE_VERSION";

// Deliberately stricter than codexClient's token pattern: the identity guards
// assert the canonical value matches /^\d+\.\d+\.\d+$/, so an override that is
// not a plain three-part version would break that invariant at runtime while
// the test suite kept passing on the default.
const SAFE_CLAUDE_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/**
 * Canonical impersonated claude-cli version. Every module that advertises a
 * Claude Code identity derives from this so the wire fingerprint cannot drift
 * apart (guarded by tests/unit/claude-identity-version-sync.test.ts).
 */
export function getClaudeCodeClientVersion(): string {
  const raw = process.env[CLAUDE_CODE_VERSION_OVERRIDE_ENV];
  if (typeof raw !== "string") return DEFAULT_CLAUDE_CODE_VERSION;
  const normalized = raw.trim();
  if (!normalized || !SAFE_CLAUDE_VERSION_PATTERN.test(normalized)) {
    return DEFAULT_CLAUDE_CODE_VERSION;
  }
  return normalized;
}

export { DEFAULT_CLAUDE_CODE_VERSION as PINNED_CLAUDE_CODE_VERSION };
