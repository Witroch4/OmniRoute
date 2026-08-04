import { createHash } from "node:crypto";
import { getIdempotencyKey, checkIdempotency } from "@/lib/idempotencyLayer";
import { calculateCost } from "@/lib/usage/costCalculator";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import {
  cloneShallowForModelEcho,
  echoModelInObject,
  resolveEchoHeaderValue,
} from "../../services/responseModelEcho.ts";

/**
 * NEXA fusion-idempotency fix: compose the effective idempotency key from the raw
 * header key + target provider/model + a digest of the request messages.
 *
 * Why: combo-internal sub-requests (fusion panel members AND the judge) re-enter
 * chatCore SHARING the client's headers, so the raw `Idempotency-Key`/`x-request-id`
 * key was identical for all of them. A panel answer saved under the key and the
 * judge's check (~1ms later, well inside the 5s window) replayed it — the client
 * received a panel member's answer instead of the judge synthesis. Namespacing by
 * model separates panel members; the messages digest separates the judge even when
 * it reuses a panel member's model (the judge body appends the judge directive
 * turn). A genuine client retry (same key, same model, same body) still replays.
 */
export function composeIdempotencyKey({
  rawKey,
  provider,
  model,
  messages,
}: {
  rawKey: string | null | undefined;
  provider: string;
  model: string;
  messages: unknown;
}): string | null {
  if (!rawKey) return null;
  let digest = "";
  try {
    digest = createHash("sha256")
      .update(JSON.stringify(messages ?? ""))
      .digest("hex")
      .slice(0, 16);
  } catch {
    digest = "nodigest";
  }
  return `${rawKey}|${provider}|${model}|${digest}`;
}

/**
 * Resolve the request's idempotency key once and check the idempotency store. Returns the
 * resolved `idempotencyKey` alongside the cache `hit` so the caller can reuse the SAME key
 * for the later save path instead of re-deriving it — eliminating the dual-derivation that
 * the chatCore modularization (#3598) introduced. (#3821-review LEDGER-6)
 */
export async function checkIdempotencyCache({
  clientRawRequest,
  provider,
  model,
  body,
  effectiveServiceTier,
  startTime,
  log,
  billedProvider = null,
  billedModel = null,
}: {
  clientRawRequest: unknown;
  provider: string;
  model: string;
  body?: unknown;
  effectiveServiceTier: unknown;
  startTime: number;
  log: unknown;
  /** Provider the CLIENT asked for, when a model budget rule redirected THIS request. */
  billedProvider?: string | null;
  /** Model the CLIENT asked for, when a model budget rule redirected THIS request. */
  billedModel?: string | null;
}): Promise<{ hit: { success: true; response: Response } | null; idempotencyKey: string | null }> {
  // NEXA fusion-idempotency fix: namespace the raw header key (see composeIdempotencyKey).
  const rawIdempotencyKey = getIdempotencyKey(clientRawRequest?.headers);
  const idempotencyKey = composeIdempotencyKey({
    rawKey: rawIdempotencyKey,
    provider,
    model,
    messages: (body as { messages?: unknown } | undefined)?.messages,
  });
  const cachedIdemp = checkIdempotency(idempotencyKey);
  if (cachedIdemp) {
    log?.debug?.("IDEMPOTENCY", `Hit for key=${idempotencyKey?.slice(0, 12)}...`);
    const idempotentUsage =
      cachedIdemp.response && typeof cachedIdemp.response === "object"
        ? ((cachedIdemp.response as Record<string, unknown>).usage as
            Record<string, unknown> | undefined)
        : undefined;
    // Confidentiality (review round 2): this response is being replayed for THIS
    // request, so it must reflect THIS request's own redirect state, not whatever
    // the original request that populated the store happened to be — see
    // resolveEchoHeaderValue's doc comment. `headerProvider`/`headerModel` are also
    // the pair the body below gets rewritten to, so header and body always agree.
    const headerProvider = resolveEchoHeaderValue(provider, billedProvider);
    const headerModel = resolveEchoHeaderValue(model, billedModel);
    // Same billed-vs-served cost split established in review round 1
    // (chatCore.ts's headerResponseCost): on a redirect, the cost this reader sees
    // must be priced at the BILLED model's rates, or a client comparing it against
    // the requested model's published price catches the served (cheaper) rate.
    const idempotentCost = idempotentUsage
      ? await calculateCost(
          headerProvider || provider,
          headerModel || model,
          idempotentUsage as Record<string, number>,
          { serviceTier: effectiveServiceTier }
        )
      : 0;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-OmniRoute-Idempotent": "true",
    };
    attachOmniRouteMetaHeaders(headers, {
      provider: headerProvider,
      model: headerModel,
      cacheHit: false,
      latencyMs: Date.now() - startTime,
      usage: idempotentUsage,
      costUsd: idempotentCost,
    });
    // Clone before rewriting `model`: `cachedIdemp.response` is the SAME object every
    // reader within the idempotency window gets back (idempotencyLayer stores by
    // reference), so mutating it in place would leak this reader's resolved model into
    // a later reader with a different redirect state. This also applies the existing
    // #6426 header/body alignment rule to the replay path, which it never had before.
    const echoedResponse = cloneShallowForModelEcho(cachedIdemp.response);
    echoModelInObject(echoedResponse, headerModel);
    return {
      idempotencyKey,
      hit: {
        success: true,
        response: new Response(JSON.stringify(echoedResponse), {
          status: cachedIdemp.status,
          headers,
        }),
      },
    };
  }
  return { hit: null, idempotencyKey };
}
