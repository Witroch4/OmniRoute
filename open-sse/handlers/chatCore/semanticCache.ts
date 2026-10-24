import {
  generateSignature,
  getCachedResponse,
  isCacheableForRead,
  recordSemanticCacheHit,
  outputContractOf,
} from "@/lib/semanticCache";
import { calculateRequestCost } from "@/lib/usage/costCalculator";
import { getUserDatabaseSettings } from "@/lib/db/databaseSettings";
import { finalizePendingScope, type PendingRequestScope } from "@/lib/usage/pendingRequestScope";
import { synthesizeOpenAiSseFromJson } from "../../utils/jsonToSse.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { extractUsageFromResponse } from "../usageExtractor.ts";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import {
  cloneShallowForModelEcho,
  echoModelInObject,
  resolveEchoHeaderValue,
} from "../../services/responseModelEcho.ts";
import { getSemanticCacheManager } from "../../services/cache/semanticCacheManager.ts";

export function isSemanticCacheEnabled(
  settings: Record<string, unknown>,
  apiKeyInfo?: { cacheDefaultMode?: unknown } | null
): boolean {
  // Use the same decision for lookup and both response-store paths. The database
  // toggle lives outside the general settings namespace.
  return (
    apiKeyInfo?.cacheDefaultMode !== "bypass" &&
    settings.semanticCacheEnabled !== false &&
    getUserDatabaseSettings().cache.semanticCacheEnabled !== false
  );
}

export async function checkSemanticCache({
  semanticCacheEnabled,
  body,
  clientRawRequest,
  model,
  provider,
  stream,
  reqLogger,
  effectiveServiceTier,
  pendingScope,
  startTime,
  log,
  persistAttemptLogs,
  apiKeyId,
  cacheDefaultMode,
  videoTranscriptSensitive,
  billedProvider = null,
  billedModel = null,
}: {
  semanticCacheEnabled: boolean;
  // Only the fields this read path actually touches are named; everything else
  // on the request body stays `unknown` via the index signature.
  body: Record<string, unknown> & { temperature?: number; top_p?: number };
  clientRawRequest: { headers?: unknown } | null;
  model: string;
  provider: string;
  stream: boolean;
  reqLogger: { logConvertedResponse: (response: Record<string, unknown>) => void };
  effectiveServiceTier: string | null | undefined;
  pendingScope: PendingRequestScope;
  startTime: number;
  log: { debug?: (...args: unknown[]) => void } | null;
  persistAttemptLogs: (args: unknown) => void;
  apiKeyId?: string | null;
  cacheDefaultMode?: "legacy" | "bypass" | null;
  videoTranscriptSensitive?: boolean;
  /** Provider the CLIENT asked for, when a model budget rule redirected THIS request. */
  billedProvider?: string | null;
  /** Model the CLIENT asked for, when a model budget rule redirected THIS request. */
  billedModel?: string | null;
}) {
  if (videoTranscriptSensitive) return null;
  // Per-key bypass: skip cache lookup entirely when the API key opts out.
  if (cacheDefaultMode === "bypass") return null;
  if (semanticCacheEnabled && isCacheableForRead(body, clientRawRequest?.headers)) {
    const manager = getSemanticCacheManager();
    const managerResult = await manager.lookup({
      body,
      headers: clientRawRequest?.headers,
      model,
      provider,
      stream,
      apiKeyId: apiKeyId ?? undefined,
      cacheDefaultMode,
    });

    let cached: Record<string, unknown> | null = null;
    let hitType: "exact" | "semantic" = "exact";
    let similarity: number | undefined;

    if (managerResult.hit && managerResult.entry) {
      cached = managerResult.entry.response;
      hitType = managerResult.type || "exact";
      similarity = managerResult.similarity;
    } else {
      // Legacy SQLite / in-memory cache check fallback. Include tool_choice/tools/
      // response_format (#12309/#12734), plus the Responses-API text.format spelling
      // (#12307), in the signature: they change model behavior and must not collide
      // with a signature computed without them.
      const signature = generateSignature(
        model,
        body.messages ?? body.input,
        body.temperature,
        body.top_p,
        apiKeyId ?? undefined,
        outputContractOf(body)
      );
      const legacyCached = getCachedResponse(signature);
      if (legacyCached) {
        cached = legacyCached as Record<string, unknown>;
        hitType = "exact";
      }
    }

    if (cached) {
      log?.debug?.("CACHE", `Semantic cache HIT (${hitType}) for ${model} (stream=${stream})`);
      reqLogger.logConvertedResponse(cached);
      const cachedUsage =
        extractUsageFromResponse(cached, provider) ||
        (cached?.usage as Record<string, unknown> | undefined);
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
        ? await calculateRequestCost(
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
        tokens: cached?.usage,
        responseBody: cached,
        providerRequest: null,
        providerResponse: null,
        clientResponse: cached,
        // Both hit types are served without an upstream call; attemptLogging only
        // knows "semantic" | "upstream", so a similarity hit must not fall through
        // to "upstream" (#14159). The hit type is surfaced via the response headers.
        cacheSource: "semantic",
      });
      // Finalize by exact request id (#12910): a (model, provider, connectionId)
      // tuple can match the wrong in-flight request when connectionId is null or
      // multiple requests share the same connection.
      finalizePendingScope(pendingScope, {
        status: 200,
        providerResponse: cached,
        clientResponse: cached,
      });

      const echoedCached = cloneShallowForModelEcho(cached);
      echoModelInObject(echoedCached, headerModel);
      // The client-facing body/stream carries THIS reader's resolved model (budget
      // redirect confidentiality — see the comment above). Stream chunks stored on the
      // manager entry are rewritten on clones so the shared entry never changes.
      const echoedEntry =
        managerResult.entry && headerModel
          ? {
              ...managerResult.entry,
              response: echoedCached,
              streamChunks: Array.isArray(managerResult.entry.streamChunks)
                ? managerResult.entry.streamChunks.map((chunk) => {
                    const echoedChunk = cloneShallowForModelEcho(chunk);
                    echoModelInObject(echoedChunk, headerModel);
                    return echoedChunk;
                  })
                : managerResult.entry.streamChunks,
            }
          : managerResult.entry;
      const cachedSse = stream
        ? echoedEntry
          ? manager.synthesizeSseFromEntry(echoedEntry)
          : synthesizeOpenAiSseFromJson(JSON.stringify(echoedCached))
        : "";

      const tokensSaved = managerResult.entry
        ? (managerResult.tokensSaved ?? 0)
        : cachedUsage
          ? (Number(cachedUsage.prompt_tokens) || 0) + (Number(cachedUsage.completion_tokens) || 0)
          : 0;

      const requestSignature = generateSignature(
        model,
        body.messages ?? body.input,
        body.temperature,
        body.top_p,
        apiKeyId ?? undefined,
        outputContractOf(body)
      );

      const targetSignature =
        managerResult.entry?.signature ||
        (hitType === "exact" ? requestSignature : managerResult.entry?.hash);

      if (targetSignature) {
        recordSemanticCacheHit(targetSignature, tokensSaved);
      }

      const headers: Record<string, string> = {
        "Content-Type": cachedSse ? "text/event-stream" : "application/json",
        // Keep the legacy `HIT` value verbatim: consumers match it exactly
        // (tests/unit/chatcore-semantic-cache.test.ts and the chat-route suites).
        // A similarity hit is distinguished by X-OmniRoute-Cache-Similarity below.
        [OMNIROUTE_RESPONSE_HEADERS.cache]: "HIT",
        // Marker for latency measurement tools: this response served from cache
        // has synthetic (near-zero) latency, not real upstream latency.
        [OMNIROUTE_RESPONSE_HEADERS.cacheLatency]: "synthetic",
        [OMNIROUTE_RESPONSE_HEADERS.savingsTokens]: String(tokensSaved),
      };

      if (hitType === "semantic" && typeof similarity === "number") {
        headers[OMNIROUTE_RESPONSE_HEADERS.cacheSimilarity] = similarity.toFixed(4);
      }

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
