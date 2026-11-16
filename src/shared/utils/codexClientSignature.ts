/**
 * Codex client signature — does this `/v1/responses` call (HTTP or the Responses
 * WebSocket bridge) come from an OFFICIAL Codex client (CLI/TUI, `codex exec`,
 * IDE extension, desktop app)?
 *
 * Measured 2026-11-16 against codex 0.162 (`codex exec`) captured by a local
 * listener, and on real customer traffic:
 * - headers: `originator: codex_exec` (CLI/TUI `codex_cli_rs`, IDE extension
 *   `codex_vscode`), `user-agent: <originator>/<version> (<os>; <arch>) ...`,
 *   `session-id` / `thread-id` / `x-codex-window-id`, `x-codex-turn-metadata`
 *   (JSON with installation/session/thread ids);
 * - body: `client_metadata["x-codex-installation-id"]` and
 *   `client_metadata["x-codex-turn-metadata"]` (the WebSocket frames carry both).
 *
 * The first hour of observation showed a client built on the Codex engine that
 * names itself `originator: openbot` (UA `openbot/0.169.0`): its BODY carries the
 * Codex markers, only the headers differ. So a call passes only when BOTH
 *   - the client names itself an official one: `originator` in the allowlist
 *     (`CODEX_OFFICIAL_ORIGINATORS`, comma-separated, default below) and the
 *     user-agent product is `<that originator>/<version>`; and
 *   - the score reaches 4 of 7 (body signals weigh 2 each, header signals 1).
 * Header-only forgery (3) fails; a Codex-derived client with its own name fails.
 *
 * Honest limit: every signal is client-supplied. This stops scripts, bots, lent
 * keys and honest third-party clients; not someone who copies headers AND body.
 */

export const CODEX_SIGNATURE_PASS_SCORE = 4;
export const CODEX_SIGNATURE_MAX_SCORE = 7;
export const DEFAULT_CODEX_OFFICIAL_ORIGINATORS = [
  "codex_cli_rs",
  "codex_exec",
  "codex_vscode",
] as const;

export interface CodexClientSignatureSignals {
  installationId: boolean;
  turnMetadata: boolean;
  /** `originator` is one of the official Codex clients. */
  originator: boolean;
  /** user-agent product is `<originator>/<version>` for that same originator. */
  userAgent: boolean;
  sessionHeader: boolean;
}

export interface CodexClientSignatureResult {
  ok: boolean;
  score: number;
  /** originator is official AND the user-agent matches it. */
  officialClient: boolean;
  signals: CodexClientSignatureSignals;
  /** The raw `originator` header (trimmed, max 64 chars) for observation logs. */
  originator: string | null;
  /** The first token of the user-agent (`codex_exec/0.162.0`), max 64 chars. */
  userAgentProduct: string | null;
}

type HeaderReader = Pick<Headers, "get">;

function readHeader(headers: HeaderReader | null | undefined, name: string): string {
  try {
    return headers?.get(name)?.trim() ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasTurnMetadata(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (
      (typeof parsed.session_id === "string" && parsed.session_id.length > 0) ||
      (typeof parsed.thread_id === "string" && parsed.thread_id.length > 0)
    );
  } catch {
    return false;
  }
}

/** Official originators, lower-cased; `CODEX_OFFICIAL_ORIGINATORS` overrides the default. */
export function codexOfficialOriginators(): Set<string> {
  const raw = process.env.CODEX_OFFICIAL_ORIGINATORS;
  const list =
    typeof raw === "string" && raw.trim()
      ? raw.split(",")
      : [...DEFAULT_CODEX_OFFICIAL_ORIGINATORS];
  return new Set(list.map((o) => o.trim().toLowerCase()).filter(Boolean));
}

/** Evaluate a parsed Responses body plus its request headers. Never throws. */
export function evaluateCodexClientSignature(
  headers: HeaderReader | null | undefined,
  body: unknown
): CodexClientSignatureResult {
  const record = isRecord(body) ? body : {};
  const meta = isRecord(record.client_metadata) ? record.client_metadata : {};

  const installation = meta["x-codex-installation-id"];
  const originator = readHeader(headers, "originator");
  const userAgent = readHeader(headers, "user-agent");
  const uaProduct = userAgent.split(/\s+/)[0] ?? "";
  const originatorLower = originator.toLowerCase();
  const officialOriginator =
    originatorLower.length > 0 && codexOfficialOriginators().has(originatorLower);
  const uaMatches =
    officialOriginator &&
    new RegExp(`^${originatorLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\d+\\.\\d+`).test(
      uaProduct.toLowerCase()
    );

  const signals: CodexClientSignatureSignals = {
    installationId: typeof installation === "string" && installation.trim().length > 0,
    turnMetadata:
      hasTurnMetadata(meta["x-codex-turn-metadata"]) ||
      hasTurnMetadata(readHeader(headers, "x-codex-turn-metadata")),
    originator: officialOriginator,
    userAgent: uaMatches,
    sessionHeader:
      readHeader(headers, "session-id").length > 0 ||
      readHeader(headers, "thread-id").length > 0 ||
      readHeader(headers, "x-codex-window-id").length > 0,
  };

  const score =
    (signals.installationId ? 2 : 0) +
    (signals.turnMetadata ? 2 : 0) +
    (signals.originator ? 1 : 0) +
    (signals.userAgent ? 1 : 0) +
    (signals.sessionHeader ? 1 : 0);
  const officialClient = signals.originator && signals.userAgent;

  return {
    ok: officialClient && score >= CODEX_SIGNATURE_PASS_SCORE,
    score,
    officialClient,
    signals,
    originator: originator ? originator.slice(0, 64) : null,
    userAgentProduct: uaProduct ? uaProduct.slice(0, 64) : null,
  };
}
