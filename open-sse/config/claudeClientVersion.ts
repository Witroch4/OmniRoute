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
// NOT a duplicate of the generic `<PROVIDER>_USER_AGENT` override in
// `executors/base.ts`: that one swaps the User-Agent HEADER for a provider and
// therefore cannot touch the `cc_version=` billing header, so using it alone to
// move the version produces exactly the split fingerprint the identity lockstep
// guard exists to prevent. This knob is version-level and feeds every surface.
// 2026-09-23: 2.1.259 -> 2.1.281 (current npm release). `claude-opus-5-5`
// answered "Claude Code 2.1.259 does not support this model; version 2.1.280 or
// newer is required" — third model launch gated on this string. Verified live
// with CLAUDE_CODE_VERSION=2.1.281: Opus 5.5 and every existing cc/* id answer.
//
// 3.8.53 sync: upstream grew its own single source for the same purpose
// (`src/shared/constants/claudeCodeClient.ts`, #12417: env override, call-time
// getters, build revision, npm "latest" cache). Two sources would reintroduce the
// split fingerprint this module exists to prevent, so this file is now a facade
// over that one. The fork's contract is kept there: pin = max(fork, upstream),
// `CLAUDE_CODE_VERSION` still wins (checked before upstream's
// `CLAUDE_CODE_CLIENT_VERSION`), and both overrides are strict N.N.N.
import {
  CLAUDE_CODE_CLIENT_VERSION,
  getClaudeCodeClientVersion,
} from "../../src/shared/constants/claudeCodeClient.ts";

/**
 * Canonical impersonated claude-cli version. Every module that advertises a
 * Claude Code identity derives from this so the wire fingerprint cannot drift
 * apart (guarded by tests/unit/claude-identity-version-sync.test.ts).
 */
export { getClaudeCodeClientVersion };

export { CLAUDE_CODE_CLIENT_VERSION as PINNED_CLAUDE_CODE_VERSION };
