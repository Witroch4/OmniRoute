import { checkFallbackError } from "@omniroute/open-sse/services/accountFallback.ts";

/**
 * Account failover for the image routes.
 *
 * The chat path already re-serves a request on the next account when the first
 * one answers "this model is not available here" (`checkFallbackError` ->
 * `model_capacity`, zero cooldown). The image routes picked ONE credential and
 * returned whatever it said, so a model only some accounts own (the Codex Sol /
 * Astra tiers live on one ChatGPT account, Terra / Luna on both) failed with
 * `400 The '<model>' model is not supported when using Codex with a ChatGPT
 * account` while the same model answered on /v1/responses a moment later.
 *
 * Deliberately narrow: only a 400 that the shared classifier already treats as
 * zero-cooldown account fallback is retried. Nothing is written to the
 * connection (no cooldown, no lockout), so an image failure can never take a
 * connection out of rotation for chat. 429/5xx, moderation and parameter
 * errors keep their previous behaviour.
 */

export interface ImageFailoverCredentials {
  connectionId?: string | null;
  allRateLimited?: boolean;
}

export interface ImageFailoverFailure {
  status?: number;
  error?: unknown;
}

const DEFAULT_MAX_ACCOUNT_ATTEMPTS = 5;

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return String(error);
  }
}

/** True when another account could serve the same request (model not available on THIS account). */
export function isModelUnavailableOnAccount(
  status: unknown,
  error: unknown,
  provider: string | null = null
): boolean {
  if (status !== 400) return false;
  const decision = checkFallbackError(400, stringifyError(error), 0, null, provider);
  return decision.shouldFallback === true && decision.cooldownMs === 0;
}

export async function retryImageOnOtherAccounts<
  TCredentials extends ImageFailoverCredentials,
  TResult,
>(options: {
  provider: string;
  model: string;
  credentials: TCredentials;
  result: TResult;
  /** Maps a result to its failure, or null when it succeeded. */
  getFailure: (result: TResult) => ImageFailoverFailure | null;
  /** Credentials for the same provider, skipping the connections already tried. */
  pickNext: (excludeConnectionIds: string[]) => Promise<TCredentials | null | undefined>;
  attempt: (credentials: TCredentials) => Promise<TResult>;
  log?: { info: (tag: string, message: string) => void };
  maxAccountAttempts?: number;
}): Promise<{ credentials: TCredentials; result: TResult }> {
  const { provider, model, getFailure, pickNext, attempt, log } = options;
  const limit = options.maxAccountAttempts ?? DEFAULT_MAX_ACCOUNT_ATTEMPTS;
  let credentials = options.credentials;
  let result = options.result;
  const tried: string[] = [];

  while (tried.length < limit) {
    const failure = getFailure(result);
    const connectionId = credentials?.connectionId;
    if (!failure || !connectionId) break;
    if (!isModelUnavailableOnAccount(failure.status, failure.error, provider)) break;

    tried.push(connectionId);
    let next: TCredentials | null | undefined;
    try {
      next = await pickNext(tried);
    } catch {
      break;
    }
    if (!next || next.allRateLimited || !next.connectionId || tried.includes(next.connectionId)) {
      break;
    }

    log?.info(
      "IMAGE",
      `${provider}: account ${connectionId.slice(0, 8)} cannot serve ${model} ` +
        `(${failure.status}); retrying on ${next.connectionId.slice(0, 8)}`
    );
    credentials = next;
    result = await attempt(next);
  }

  return { credentials, result };
}
