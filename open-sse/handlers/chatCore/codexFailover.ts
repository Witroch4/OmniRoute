import { getCodexModelScope } from "../../config/codexQuotaScopes.ts";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/providers";

type CodexFailoverCredentials = {
  connectionId?: string | null;
  providerSpecificData?: unknown;
};

function asProviderData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Build the client-facing error for "all Codex accounts exhausted" once failover
 * has no account left to rotate to.
 *
 * The bare upstream 429 (`[429]: The usage limit has been reached`) carries no
 * `Retry-After` and no reset time, so the Codex client retries blindly for
 * several seconds and then surfaces the unhelpful `exceeded retry limit, last
 * status: 429`. This returns a clear body (real reason + earliest reset, which
 * `getProviderCredentials` already computes) plus a bounded `Retry-After` so the
 * client backs off instead of hammering. Pure for trivial unit testing.
 *
 * @param opts.retryAfter      earliest-reset ISO timestamp (or null when unknown)
 * @param opts.retryAfterHuman human string like "reset after 5h 12m" (or null)
 */
export function buildCodexAllExhaustedError(opts: {
  retryAfter?: string | null;
  retryAfterHuman?: string | null;
  now?: number;
}): { retryAfterSeconds: number; body: string; message: string } {
  const now = opts.now ?? Date.now();
  const resetMs = opts.retryAfter ? new Date(opts.retryAfter).getTime() : Number.NaN;
  const hasReset = Number.isFinite(resetMs) && resetMs > now;
  // Floor 1s, cap 1h: enough to break the tight retry loop without telling the
  // client to wait absurdly long when the earliest reset is a far weekly window.
  const retryAfterSeconds = hasReset
    ? Math.min(3600, Math.max(1, Math.ceil((resetMs - now) / 1000)))
    : 60;
  const message = opts.retryAfterHuman
    ? `All Codex accounts have reached their usage limit. Earliest ${opts.retryAfterHuman}.`
    : `All Codex accounts have reached their usage limit. Retry later.`;
  const body = JSON.stringify({
    error: {
      message,
      // `insufficient_quota` (not a custom code) so a Codex client that reads
      // this JSON classifies it as a non-retryable quota error, matching the
      // streaming `response.failed` path.
      type: "insufficient_quota",
      code: "insufficient_quota",
      ...(hasReset ? { reset_at: opts.retryAfter } : {}),
    },
  });
  return { retryAfterSeconds, body, message };
}

/**
 * Build the SSE body that surfaces "all Codex accounts exhausted" IN-BAND on a
 * streaming request.
 *
 * A streaming Codex client (codex-rs) decides whether to retry from the HTTP
 * status *before* reading the body, so a bare 429 makes it retry blindly and end
 * with `exceeded retry limit, last status: 429` — the body is never shown. The
 * `/v1/responses` transport instead surfaces errors as a `response.failed` SSE
 * event (see codex.ts `failController`), so a 200 `text/event-stream` carrying a
 * single `response.failed` event makes the client render the real reason and
 * stop retrying. Mirrors the framing OmniRoute already emits for upstream stream
 * failures. Pure for trivial unit testing.
 */
export function buildCodexExhaustedStreamBody(message: string): string {
  const payload = JSON.stringify({
    type: "response.failed",
    response: {
      id: null,
      status: "failed",
      // The `code` MUST be `insufficient_quota`: codex-rs classifies a
      // response.failed error by its `code` and only treats
      // context_length_exceeded / insufficient_quota / usage_not_included as
      // NON-retryable (surfaced to the user). Every other code — including a
      // custom one — falls into its default `Retryable` branch and loops into
      // "exceeded retry limit". `insufficient_quota` → QuotaExceeded → the client
      // shows the usage-limit message and stops retrying.
      error: { type: "insufficient_quota", code: "insufficient_quota", message },
    },
  });
  return `event: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`;
}

export async function markCodexScopeRateLimited(params: {
  failedConnectionId: string;
  model: string | null;
  rateLimitedUntil: string;
  credentials?: CodexFailoverCredentials | null;
}): Promise<void> {
  const connection = await getProviderConnectionById(params.failedConnectionId).catch(() => null);
  const existingProviderData = connection
    ? asProviderData(connection.providerSpecificData)
    : asProviderData(params.credentials?.providerSpecificData);
  const existingScopeMap = asProviderData(existingProviderData.codexScopeRateLimitedUntil);
  const nextProviderData = {
    ...existingProviderData,
    codexScopeRateLimitedUntil: {
      ...existingScopeMap,
      [getCodexModelScope(params.model || "")]: params.rateLimitedUntil,
    },
  };

  updateProviderConnection(params.failedConnectionId, {
    ...(connection ? { providerSpecificData: nextProviderData } : {}),
    lastError: "429 rate limited — codex account rotation",
    errorCode: 429,
  }).catch(() => {});

  if (params.credentials && String(params.credentials.connectionId) === params.failedConnectionId) {
    params.credentials.providerSpecificData = nextProviderData;
  }
}
