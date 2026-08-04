import { generateSignature, getCachedResponse, isCacheableForRead } from "@/lib/semanticCache";
import { calculateCost } from "@/lib/usage/costCalculator";
import { trackPendingRequest } from "@/lib/usageDb";
import { synthesizeOpenAiSseFromJson } from "../../utils/jsonToSse.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { extractUsageFromResponse } from "../usageExtractor.ts";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import {
  cloneShallowForModelEcho,
  echoModelInObject,
  resolveEchoHeaderValue,
} from "../../services/responseModelEcho.ts";

export async function checkSemanticCache({
  semanticCacheEnabled,
  body,
  clientRawRequest,
  model,
  provider,
  stream,
  reqLogger,
  effectiveServiceTier,
  connectionId,
  startTime,
  log,
  persistAttemptLogs,
  apiKeyId,
  billedProvider = null,
  billedModel = null,
}: {
  semanticCacheEnabled: boolean;
  body: Record<string, unknown>;
  clientRawRequest: unknown;
  model: string;
  provider: string;
  stream: boolean;
  reqLogger: unknown;
  effectiveServiceTier: unknown;
  connectionId: string | null;
  startTime: number;
  log: unknown;
  persistAttemptLogs: (args: unknown) => void;
  apiKeyId?: string | null;
  /** Provider the CLIENT asked for, when a model budget rule redirected THIS request. */
  billedProvider?: string | null;
  /** Model the CLIENT asked for, when a model budget rule redirected THIS request. */
  billedModel?: string | null;
}) {
  if (semanticCacheEnabled && isCacheableForRead(body, clientRawRequest?.headers)) {
    const signature = generateSignature(
      model,
      body.messages ?? body.input,
      body.temperature,
      body.top_p,
      apiKeyId ?? undefined
    );
    const cached = getCachedResponse(signature);
    if (cached) {
      log?.debug?.("CACHE", `Semantic cache HIT for ${model} (stream=${stream})`);
      reqLogger.logConvertedResponse(cached as Record<string, unknown>);
      const cachedUsage =
        extractUsageFromResponse(cached as Record<string, unknown>, provider) ||
        ((cached as Record<string, unknown>)?.usage as Record<string, unknown> | undefined);
      // Confidentiality (review round 2): this cache entry may have been written by a
      // DIFFERENT request than the one reading it now — the semantic-cache signature is
      // keyed on the SERVED model + content + temperature/top_p + apiKeyId, not on
      // whether that write was itself redirected. So the entry must never be trusted to
      // already carry the right value for THIS reader; THIS reader's own redirect state
      // (`billedProvider`/`billedModel`) is the only honest source, exactly like the live
      // (non-cached) response path. `headerProvider`/`headerModel` are also what the body
      // gets rewritten to below, so header and body always agree.
      const headerProvider = resolveEchoHeaderValue(provider, billedProvider);
      const headerModel = resolveEchoHeaderValue(model, billedModel);
      // Same billed-vs-served split as round 1's headerResponseCost: the "would-have-cost"
      // surfaced via X-OmniRoute-Cost-Saved must be priced at the BILLED model's rates on a
      // redirect, or a client comparing it against the requested model's published price
      // catches the served (cheaper) rate — the same tell, just on the savings figure.
      const cachedCost = cachedUsage
        ? await calculateCost(
            headerProvider || provider,
            headerModel || model,
            cachedUsage as Record<string, number>,
            { serviceTier: effectiveServiceTier }
          )
        : 0;
      // Admin/debug surfaces (reqLogger, persistAttemptLogs above) intentionally keep
      // logging the RAW cached value — they want the real served model, same policy as
      // the live response path (round 1 report). Only the outgoing client response below
      // is rewritten, and only on a clone: `cached` may be the SAME object every other
      // reader of this signature gets back (in-memory LRU), so mutating it in place would
      // leak this reader's resolved model into a later reader with a different redirect
      // state — see cloneShallowForModelEcho's doc comment.
      persistAttemptLogs({
        status: 200,
        tokens: (cached as Record<string, unknown>)?.usage,
        responseBody: cached,
        providerRequest: null,
        providerResponse: null,
        clientResponse: cached,
        cacheSource: "semantic",
      });
      trackPendingRequest(model, provider, connectionId, false);
      const echoedCached = cloneShallowForModelEcho(cached);
      echoModelInObject(echoedCached, headerModel);
      const cachedSse = stream ? synthesizeOpenAiSseFromJson(JSON.stringify(echoedCached)) : "";
      const headers: Record<string, string> = {
        "Content-Type": cachedSse ? "text/event-stream" : "application/json",
        [OMNIROUTE_RESPONSE_HEADERS.cache]: "HIT",
      };
      // A cache HIT serves WITHOUT an upstream call, so the incremental cost billed to
      // the client is 0 (consumers that sum X-OmniRoute-Response-Cost must not charge for
      // hits). The original/would-have-been cost is surfaced via X-OmniRoute-Cost-Saved.
      attachOmniRouteMetaHeaders(headers, {
        provider: headerProvider,
        model: headerModel,
        cacheHit: true,
        latencyMs: Date.now() - startTime,
        usage: cachedUsage,
        costUsd: 0,
        costSavedUsd: cachedCost,
      });
      return {
        success: true,
        response: new Response(cachedSse || JSON.stringify(echoedCached), {
          headers,
        }),
      };
    }
  }
  return null;
}
