import { createHash, randomUUID } from "crypto";
import { setUserAgentHeader } from "../executors/base.ts";
import { generateSessionId } from "../services/sessionManager.ts";

/**
 * Header keys that are forwarded from the client to the upstream provider.
 * Used by both OpencodeExecutor and DefaultExecutor.
 */
const OPENCODE_HEADER_KEYS = [
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-project",
  "x-opencode-client",
] as const;

/** Client headers that carry a conversation id, in priority order (after x-opencode-session itself). */
const SESSION_HEADER_FALLBACKS = [
  "x-session-affinity",
  "x-session-id",
  "x-claude-code-session-id",
  "session_id",
  "session-id",
  "x-session_id",
  "thread_id",
  "thread-id",
  "x-thread-id",
] as const;

/**
 * Case-insensitive lookup for a header in a headers record.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * OpenCode Go v2 refuses any request without `x-opencode-session` (400 MissingSessionID on every
 * format base, measured 2026-10-24) but does not validate its value. Returns the client headers with
 * a session the request can carry: the client's own conversation id when it sends one (forwarded
 * below), otherwise a `ses_` id derived from the conversation (model, system prompt, first user
 * message, tools), so every turn of one conversation keeps one upstream session.
 */
export function withOpencodeGoSession(
  clientHeaders: Record<string, string> | null | undefined,
  body: unknown
): Record<string, string> {
  const headers = clientHeaders ?? {};
  const hasSession = ["x-opencode-session", ...SESSION_HEADER_FALLBACKS].some((name) => {
    const value = findHeader(headers, name);
    return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
  });
  if (hasSession) return headers;
  const seed = generateSessionId(sessionBodyOf(body)) ?? randomUUID();
  const digest = createHash("sha256").update(`opencode-go\u0000${seed}`).digest("hex");
  return { ...headers, "x-opencode-session": `ses_${digest.slice(0, 26)}` };
}

/** Fingerprint inputs of any wire format; Google keeps them in `contents`/`systemInstruction`. */
function sessionBodyOf(body: unknown): Parameters<typeof generateSessionId>[0] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const contents = Array.isArray(record.contents)
    ? (record.contents as Array<{ role?: string; parts?: unknown }>)
    : undefined;
  return {
    model: typeof record.model === "string" ? record.model : undefined,
    system: record.system ?? record.systemInstruction,
    tools: Array.isArray(record.tools) ? record.tools : undefined,
    messages: Array.isArray(record.messages)
      ? record.messages
      : contents?.map((content) => ({ role: content?.role, content: content?.parts })),
    input: Array.isArray(record.input) ? record.input : undefined,
  };
}

/**
 * Forward OpenCode client request metadata headers to the upstream provider.
 *
 * Shared logic used by OpencodeExecutor and DefaultExecutor:
 * 1. Forwards User-Agent from clientHeaders via `setUserAgentHeader()`
 * 2. Forwards x-opencode-session, x-opencode-request, x-opencode-project,
 *    x-opencode-client headers (case-insensitive match)
 *
 * @param headers - The outbound headers record to mutate
 * @param clientHeaders - The client-provided headers to forward from
 * @param options.synthesizeRequestId - When true (OpencodeExecutor only), maps
 *   x-session-affinity / x-session-id to x-opencode-session when the latter is
 *   missing, and synthesizes a UUID for x-opencode-request if also missing.
 * @param options.cliDefaults - When provided (OpencodeExecutor only), synthesize
 *   the OpenCode CLI identity headers that Cloudflare requires on VPS egress
 *   (User-Agent, x-opencode-client, x-opencode-project) plus fresh request/session
 *   UUIDs, but ONLY for keys the client did not already supply. Client values always
 *   win; these defaults only fill gaps. (#5997)
 */
export function forwardOpencodeClientHeaders(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  options?: {
    synthesizeRequestId?: boolean;
    cliDefaults?: { userAgent: string; client: string; project: string };
  }
): void {
  // 1. Forward User-Agent
  const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
  if (clientUA) {
    setUserAgentHeader(headers, clientUA);
  }

  // 2. Forward x-opencode-* metadata headers
  for (const headerName of OPENCODE_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 3. OpencodeExecutor-only: synthesize session/request id from fallback headers
  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    // OpenCode Go asks for a STABLE session id per conversation. Reuse whichever conversation id the
    // client already sends (Claude Code sends x-claude-code-session-id) instead of leaving it unset or
    // minting a fresh UUID per request. Same header list as upstream's opencodeSessionIdentity.
    const sessionAffinity = SESSION_HEADER_FALLBACKS.map((name) =>
      findHeader(clientHeaders, name)
    ).find((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256);
    if (sessionAffinity) {
      headers["x-opencode-session"] = sessionAffinity;

      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = randomUUID();
      }
    }
  }

  // 4. OpencodeExecutor-only: synthesize the OpenCode CLI identity Cloudflare expects
  //    on VPS egress, for any key the client did not supply (#5997).
  if (options?.cliDefaults) {
    applyCliDefaults(headers, options.cliDefaults);
  }
}

/**
 * Fill the OpenCode CLI identity headers Cloudflare requires on VPS egress, but only for
 * keys the client did not already supply (client values always win). (#5997)
 */
function applyCliDefaults(
  headers: Record<string, string>,
  cliDefaults: { userAgent: string; client: string; project: string }
): void {
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    setUserAgentHeader(headers, cliDefaults.userAgent);
  }
  headers["x-opencode-client"] ||= cliDefaults.client;
  headers["x-opencode-project"] ||= cliDefaults.project;
  headers["x-opencode-request"] ||= randomUUID();
  headers["x-opencode-session"] ||= randomUUID();
}
