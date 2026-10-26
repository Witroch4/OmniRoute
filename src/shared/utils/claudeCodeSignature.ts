/**
 * Claude Code request signature.
 *
 * The "Anthropic-native only (Claude Code)" checkbox (`chat:messages`) only
 * proves the wire PROTOCOL: anything that speaks `/v1/messages` passes, so a
 * script using an Anthropic SDK rode a Claude-Code-only key (a medical-quiz
 * generator was found doing exactly that). This module decides whether a request
 * LOOKS like it came from the Claude Code client, from signals measured on the
 * real client (2.1.292 captured locally against a fake server, 2.1.310 in
 * production traffic), across `claude -p`, `--system-prompt`,
 * `--append-system-prompt`, `--model haiku`, `--bare` and the VS Code extension:
 *
 *   body    system[0]        `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;`
 *   body    metadata.user_id JSON `{device_id, session_id, account_uuid}` (or the older
 *                            `user_<hex>_account_<uuid>_session_<uuid>` string)
 *   header  user-agent       `claude-cli/<version> (external, <entrypoint>)`
 *   header  x-app            `cli`
 *   header  anthropic-beta   contains `claude-code-`
 *
 * What is NOT a signal, on purpose: the number of tools (0 with `--tools ""`, 3 with
 * `--bare`, 13–52 in normal use), the version string (it moves every release), the
 * model, and the entrypoint value (`cli`, `sdk-cli`, `claude-vscode`, …).
 *
 * Scoring instead of all-or-nothing: the two BODY signals weigh 2 and the three
 * HEADER signals weigh 1, and a request passes at 4 of 7. That makes the outcome
 * robust to one missing/rewritten piece (a proxy that drops a header, an older
 * client without the billing block) while keeping header-only forgery
 * (1+1+1 = 3) out: copying three headers is not enough, the body has to carry
 * the client's own markers too.
 *
 * Honest limit: every signal is client-supplied, so someone who deliberately
 * reproduces headers AND body passes. This stops scripts, bots and accidental
 * reuse of a key, not a determined impersonator.
 */

export const CLAUDE_CODE_SIGNATURE_PASS_SCORE = 4;
export const CLAUDE_CODE_SIGNATURE_MAX_SCORE = 7;

const BILLING_BLOCK = /^x-anthropic-billing-header:\s*cc_version=[\w.-]+;\s*cc_entrypoint=[\w-]+;/;
const LEGACY_USER_ID = /^user_[0-9a-f]{16,}_account_[0-9a-f-]*_session_[0-9a-f-]{8,}$/i;

export interface ClaudeCodeSignatureSignals {
  billingBlock: boolean;
  metadataUserId: boolean;
  userAgent: boolean;
  xApp: boolean;
  betaHeader: boolean;
}

export interface ClaudeCodeSignatureResult {
  ok: boolean;
  score: number;
  signals: ClaudeCodeSignatureSignals;
}

type HeaderReader = Pick<Headers, "get">;

function firstSystemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system) || system.length === 0) return "";
  const first = system[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function hasClaudeCodeUserId(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const userId = (metadata as { user_id?: unknown }).user_id;
  if (typeof userId !== "string" || userId.length === 0) return false;
  if (LEGACY_USER_ID.test(userId)) return true;
  if (!userId.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(userId) as { device_id?: unknown; session_id?: unknown };
    return (
      typeof parsed.device_id === "string" &&
      parsed.device_id.length > 0 &&
      typeof parsed.session_id === "string" &&
      parsed.session_id.length > 0
    );
  } catch {
    return false;
  }
}

/** Evaluate a parsed `/v1/messages` body plus its request headers. Never throws. */
export function evaluateClaudeCodeSignature(
  headers: HeaderReader | null | undefined,
  body: unknown
): ClaudeCodeSignatureResult {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const read = (name: string): string => {
    try {
      return headers?.get(name)?.trim() ?? "";
    } catch {
      return "";
    }
  };

  const signals: ClaudeCodeSignatureSignals = {
    billingBlock: BILLING_BLOCK.test(firstSystemText(record.system).trimStart()),
    metadataUserId: hasClaudeCodeUserId(record.metadata),
    userAgent: read("user-agent").toLowerCase().startsWith("claude-cli/"),
    xApp: read("x-app").toLowerCase() === "cli",
    betaHeader: read("anthropic-beta").toLowerCase().includes("claude-code-"),
  };

  const score =
    (signals.billingBlock ? 2 : 0) +
    (signals.metadataUserId ? 2 : 0) +
    (signals.userAgent ? 1 : 0) +
    (signals.xApp ? 1 : 0) +
    (signals.betaHeader ? 1 : 0);

  return { ok: score >= CLAUDE_CODE_SIGNATURE_PASS_SCORE, score, signals };
}
