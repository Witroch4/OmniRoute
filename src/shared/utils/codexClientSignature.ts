/**
 * Codex client signature — does this `/v1/responses` call (HTTP or the Responses
 * WebSocket bridge) LOOK like it came from an official Codex client (CLI, `codex
 * exec`, IDE extension, desktop app), from signals measured on the real client?
 *
 * Measured 2026-11-16 against codex 0.162 (`codex exec`) captured by a local
 * listener, and on the stored bodies of real customer traffic:
 * - headers: `originator: codex_exec` (CLI/TUI send `codex_cli_rs`, the IDE
 *   `codex_vscode`), `user-agent: <originator>/<version> (<os>; <arch>) ...`,
 *   `session-id` / `thread-id` / `x-codex-window-id`, `x-codex-turn-metadata`
 *   (JSON with installation/session/thread ids);
 * - body: `client_metadata["x-codex-installation-id"]` and
 *   `client_metadata["x-codex-turn-metadata"]` (the WebSocket frames carry both).
 *
 * Scoring mirrors `claudeCodeSignature.ts`: the two BODY signals weigh 2, the
 * three HEADER signals weigh 1, and a call passes at 4 of 7. Header-only forgery
 * (3) fails; a genuine body behind a proxy that dropped every header (4) passes.
 *
 * Honest limit: every signal is client-supplied. This stops scripts, bots and a
 * key lent to another tool; it does not stop someone who copies headers AND body.
 */

export const CODEX_SIGNATURE_PASS_SCORE = 4;
export const CODEX_SIGNATURE_MAX_SCORE = 7;

export interface CodexClientSignatureSignals {
  installationId: boolean;
  turnMetadata: boolean;
  originator: boolean;
  userAgent: boolean;
  sessionHeader: boolean;
}

export interface CodexClientSignatureResult {
  ok: boolean;
  score: number;
  signals: CodexClientSignatureSignals;
  /** The raw `originator` header (trimmed, max 64 chars) for observation logs. */
  originator: string | null;
  /** The first token of the user-agent (`codex_exec/0.162.0`), max 64 chars. */
  userAgentProduct: string | null;
}

type HeaderReader = Pick<Headers, "get">;

// codex_cli_rs, codex_exec, codex_vscode, codex_desktop, "Codex Desktop"…
const CODEX_ORIGINATOR = /^codex[\w .-]{0,40}$/i;
// "<product>/<version>" where product is a codex originator token.
const CODEX_UA_PRODUCT = /^codex[\w.-]{0,40}\/\d+\.\d+/i;

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

  const signals: CodexClientSignatureSignals = {
    installationId: typeof installation === "string" && installation.trim().length > 0,
    turnMetadata:
      hasTurnMetadata(meta["x-codex-turn-metadata"]) ||
      hasTurnMetadata(readHeader(headers, "x-codex-turn-metadata")),
    originator: CODEX_ORIGINATOR.test(originator),
    userAgent: CODEX_UA_PRODUCT.test(uaProduct),
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

  return {
    ok: score >= CODEX_SIGNATURE_PASS_SCORE,
    score,
    signals,
    originator: originator ? originator.slice(0, 64) : null,
    userAgentProduct: uaProduct ? uaProduct.slice(0, 64) : null,
  };
}
