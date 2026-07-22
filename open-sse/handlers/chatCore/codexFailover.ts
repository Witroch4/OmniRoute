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
      type: "insufficient_quota",
      code: "codex_all_accounts_exhausted",
      ...(hasReset ? { reset_at: opts.retryAfter } : {}),
    },
  });
  return { retryAfterSeconds, body, message };
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
