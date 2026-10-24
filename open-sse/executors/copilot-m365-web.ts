import WebSocket from "ws";
import { FETCH_TIMEOUT_MS } from "../config/constants.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { prependBufferedChunks } from "../utils/streamReadiness.ts";
import { cooldownUntilMs } from "../services/accountFallback.ts";
import { parseRetryAfter } from "../../src/shared/utils/classify429.ts";
import {
  getConnectionRateLimitUntil,
  markConnectionRateLimitedUntil,
} from "../../src/lib/db/providers/rateLimit.ts";
import { BaseExecutor, type ExecuteInput, type ExecutorLog } from "./base.ts";
import {
  buildPrompt,
  buildRouterPrompt,
  buildWsUrl,
  currentM365AccessToken,
  currentM365ChathubPath,
  decodeJwtClaims,
  extractToolSpec,
  flattenMessages,
  redactWsUrl,
  refreshM365AccessToken,
  resolveConnectionParams,
  tokenNeedsRefresh,
} from "./copilot-m365-connection.ts";
import {
  accumulateBotContent,
  buildChatInvocation,
  clientPlugins,
  encodeFrame,
  extractCompletionError,
  extractFinalResultMessage,
  extractM365RateLimitMessage,
  handshakeError,
  handshakeFrame,
  isCompletionFrame,
  isUpdateFrame,
  keepaliveFrame,
  metricsFrame,
  parseFencedToolCalls,
  parseFrame,
  parseToolRouterDecision,
  resolveChatInvocationOverrides,
  resolveToneForModel,
  splitFrames,
} from "./copilot-m365-frames.ts";
import {
  extractM365Images,
  M365ImageUploadError,
  uploadM365Images,
  type M365ImageAnnotation,
} from "./copilot-m365-images.ts";

type JsonRecord = Record<string, unknown>;
type M365ToolDecl = {
  name: string;
  description: string;
  parameters: JsonRecord | null;
};
let WebSocketCtor: typeof WebSocket = WebSocket;
// Fork: operator protection, not a Microsoft-published reset window.
const M365_THROTTLE_COOLDOWN_SECONDS = 15 * 60;

function m365CoolingSeconds(retryAfter?: string | null): number {
  return Math.max(M365_THROTTLE_COOLDOWN_SECONDS, parseRetryAfter(retryAfter ?? undefined) ?? 0);
}

export function __setCopilotM365WebSocketForTesting(ctor: typeof WebSocket): () => void {
  const previous = WebSocketCtor;
  WebSocketCtor = ctor;
  return () => {
    WebSocketCtor = previous;
  };
}

/**
 * Cap on the pending (unterminated) frame buffer of a wsChat socket. Complete
 * frames are split out on every socket message, so only partial frames are
 * retained; past this cap the turn aborts instead of accumulating the buffer
 * without bound. Same 1 MiB budget as the claude-web SSE reader
 * (`MAX_CLAUDE_WEB_SSE_PENDING_CHARS`).
 */
const MAX_COPILOT_WS_PENDING_CHARS = 1024 * 1024;

function sseChunk(model: string, delta: JsonRecord, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-copilot-m365-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/**
 * Describe an unrecognized `type:1 target:update` frame by its top-level argument keys
 * only (#7858 AC: log shape, never content/tokens/cookies) so the next unrecognized-shape
 * report arrives with the data needed to add a handler.
 */
function describeUpdateFrameShape(frame: Record<string, unknown> | null): string | null {
  if (!isUpdateFrame(frame) || !frame) return null;
  const args = frame.arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) return null;
  return Object.keys(first).join(",");
}

function errorResponse(message: string, status = 502, retryAfterSeconds?: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: sanitizeErrorMessage(message),
        ...(status === 429 ? { type: "rate_limit_error", code: "rate_limit_exceeded" } : {}),
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
      },
    }
  );
}

/** Fork: the error event wsChat emits, read back so it can become a real HTTP status. */
function streamError(
  chunk: Uint8Array
): { message: string; status: number; retryAfterSeconds?: number } | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(chunk).trim().slice(6)) as {
      error?: { message?: unknown; status?: unknown; retryAfterSeconds?: unknown };
    };
    if (typeof parsed.error?.message !== "string") return null;
    return {
      message: sanitizeErrorMessage(parsed.error.message),
      status: parsed.error.status === 429 ? 429 : 502,
      retryAfterSeconds:
        typeof parsed.error.retryAfterSeconds === "number"
          ? parsed.error.retryAfterSeconds
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Consume one wsChat SSE stream to its full text (router turns are read fully). */
async function readSseText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as JsonRecord;
        const choices = parsed.choices;
        const choice = (Array.isArray(choices) ? choices[0] : undefined) as
          { delta?: { content?: unknown } } | undefined;
        if (typeof choice?.delta?.content === "string") fullText += choice.delta.content;
      } catch {
        /* skip malformed SSE lines */
      }
    }
  }
  return fullText;
}

/** Build the tool_calls result for a routed decision (stream + non-stream). */
function toolCallsResult(
  calls: Array<{ id: string; type: string; name: string; arguments: string }>,
  opts: { stream: boolean; model: string; wsUrl: string }
) {
  if (opts.stream) {
    let sse = sseChunk(opts.model, { role: "assistant", content: null });
    for (let i = 0; i < calls.length; i++) {
      sse += sseChunk(opts.model, {
        tool_calls: [
          {
            index: i,
            id: calls[i]!.id,
            type: calls[i]!.type,
            function: { name: calls[i]!.name, arguments: calls[i]!.arguments },
          },
        ],
      });
    }
    sse += sseChunk(opts.model, {}, "tool_calls") + "data: [DONE]\n\n";
    return {
      response: new Response(sse, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: redactWsUrl(opts.wsUrl),
      headers: {},
      transformedBody: { model: opts.model, toolCalls: calls.length },
    };
  }
  return {
    response: new Response(
      JSON.stringify({
        id: `chatcmpl-copilot-m365-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: opts.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: c.type,
                function: { name: c.name, arguments: c.arguments },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { headers: { "Content-Type": "application/json" } }
    ),
    url: redactWsUrl(opts.wsUrl),
    headers: {},
    transformedBody: { model: opts.model, toolCalls: calls.length },
  };
}

export class CopilotM365WebExecutor extends BaseExecutor {
  constructor() {
    super("copilot-m365-web", { id: "copilot-m365-web", baseUrl: "wss://substrate.office.com" });
  }

  private async wsChat(input: {
    wsUrl: string;
    prompt: string;
    model: string;
    tier?: string;
    tools?: M365ToolDecl[];
    toolChoice?: unknown;
    /** Fork: images uploaded to this conversation (copilot-m365-images.ts). */
    messageAnnotations?: M365ImageAnnotation[];
    /** Fork: the connection to cool down when Microsoft throttles. */
    connectionId?: string;
    signal?: AbortSignal;
    log?: ExecutorLog | null;
  }): Promise<ReadableStream<Uint8Array>> {
    // #6210 — observability for the empty-response class. The access_token rides
    // in the WS query string, so every URL logged here goes through redactWsUrl().
    const log = input.log ?? null;
    const toolMode = (input.tools?.length ?? 0) > 0;
    let cancelChat = () => {};
    return new ReadableStream<Uint8Array>(
      {
        start: async (controller) => {
          const encoder = new TextEncoder();
          let ws: WebSocket | null = null;
          let settled = false;
          let buffer = "";
          let previousText = "";
          // Tool-call streaming: with tools declared, content is emitted with a
          // small tail holdback until a fenced block opens — from then on everything
          // is buffered and resolved into `tool_calls` at finish, never as content.
          let pendingTail = "";
          let fenceSeen = false;
          let finalResultMessage = "";
          let handshakeComplete = false;

          const cleanup = () => {
            input.signal?.removeEventListener("abort", onAbort);
            if (ws) {
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              ws = null;
            }
          };

          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            cleanup();
            // Last-resort fallback (#6210): some EDU turns surface the answer only
            // in the type:2 invocation result. Treat it as the turn text.
            if (!previousText && finalResultMessage) {
              previousText = finalResultMessage;
            }
            // Tool-call resolution: parse the fenced-block protocol out of the
            // completed turn and, when the model called declared tools, close the
            // stream with OpenAI `tool_calls` instead of plain content.
            const calls = toolMode
              ? parseFencedToolCalls(previousText, input.tools ?? [], input.toolChoice)
              : [];
            if (calls.length > 0) {
              controller.enqueue(
                encoder.encode(sseChunk(input.model, { role: "assistant", content: null }))
              );
              for (let i = 0; i < calls.length; i++) {
                const call = calls[i]!;
                controller.enqueue(
                  encoder.encode(
                    sseChunk(input.model, {
                      tool_calls: [
                        {
                          index: i,
                          id: call.id,
                          type: call.type,
                          function: { name: call.name, arguments: call.arguments },
                        },
                      ],
                    })
                  )
                );
              }
              controller.enqueue(encoder.encode(sseChunk(input.model, {}, "tool_calls")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            if (!previousText) {
              // #7858 — a turn that completed with no content in ANY known shape is
              // indistinguishable, from the outside, from a genuine successful-but-empty
              // reply. Fail loudly instead of a silent `stop`, per Hard Rule #12.
              const tierNote = input.tier
                ? `resolved tier: ${input.tier}`
                : "resolved tier: individual (default)";
              const message = sanitizeErrorMessage(
                `Microsoft 365 Copilot turn completed with no content in any known frame ` +
                  `shape (${tierNote}). Possible causes: an unrecognized frame shape for ` +
                  `this tenant, or a misconfigured tier.`
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`)
              );
              controller.close();
              return;
            }
            // No tool calls: flush any holdback tail as ordinary content and stop.
            if (pendingTail) {
              controller.enqueue(encoder.encode(sseChunk(input.model, { content: pendingTail })));
              pendingTail = "";
            }
            controller.enqueue(encoder.encode(sseChunk(input.model, {}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };

          // Fork: a throttle is a 429 with a local cooling period (persisted on the connection,
          // so requests already queued for it are refused before they upload or connect).
          const abort = (reason: string, status = 502, retryAfterHint?: string) => {
            if (settled) return;
            clearTimeout(timeout);
            settled = true;
            cleanup();
            const message = sanitizeErrorMessage(reason);
            const retryAfterSeconds =
              status === 429 ? m365CoolingSeconds(retryAfterHint) : undefined;
            if (status === 429 && input.connectionId) {
              markConnectionRateLimitedUntil(
                input.connectionId,
                m365CoolingSeconds(retryAfterHint) * 1000
              );
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { message, status, retryAfterSeconds } })}\n\n`
              )
            );
            controller.close();
          };

          const onAbort = () => abort("Request aborted");
          input.signal?.addEventListener("abort", onAbort, { once: true });

          const timeout = setTimeout(
            () => abort("Microsoft 365 Copilot WebSocket timeout"),
            FETCH_TIMEOUT_MS
          );
          // Fork: the consumer cancelling the response stream closes the socket.
          cancelChat = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            cleanup();
          };
          if (input.signal?.aborted) {
            onAbort();
            return;
          }

          // Aborts the turn when the pending (unterminated) frame buffer passes the
          // cap, returning true so the caller skips the frame loop. Complete frames
          // are split out on every socket message, so only partial frames are retained.
          const abortIfBufferOverCap = (): boolean => {
            if (buffer.length <= MAX_COPILOT_WS_PENDING_CHARS) return false;
            clearTimeout(timeout);
            log?.debug?.(
              "COPILOT_WS",
              `pending frame buffer exceeded the size limit (${buffer.length} chars)`
            );
            abort("Microsoft 365 Copilot pending frame buffer exceeded the size limit");
            return true;
          };

          try {
            const wsUrlParts = new URL(input.wsUrl);
            // #10718 — the invocation must echo the ids riding in the WS URL query
            // (conversationId is cross-checked server-side). traceId is a fresh GUID
            // per turn, as in the browser capture.
            const requestId =
              wsUrlParts.searchParams.get("chatsessionid") ??
              wsUrlParts.searchParams.get("clientrequestid") ??
              crypto.randomUUID();
            const sessionId = wsUrlParts.searchParams.get("X-SessionId") ?? crypto.randomUUID();
            const conversationId =
              wsUrlParts.searchParams.get("ConversationId") ?? crypto.randomUUID();
            const traceId = crypto.randomUUID();

            log?.debug?.("M365_WS", `connecting → ${redactWsUrl(input.wsUrl)}`);

            ws = new WebSocketCtor(input.wsUrl, {
              headers: {
                Origin: "https://m365.cloud.microsoft",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
              },
            });

            const sendChat = () => {
              const overrides = resolveChatInvocationOverrides(input.tier);
              // Model-driven tone (#7872) wins over the tier default; a bare/unknown id
              // keeps the tier tone resolved above.
              const tone = resolveToneForModel(input.model) ?? overrides.tone;
              const invocationFrame = encodeFrame(
                buildChatInvocation({
                  text: input.prompt,
                  traceId,
                  sessionId,
                  requestId,
                  conversationId,
                  messageAnnotations: input.messageAnnotations,
                  isStartOfSession: true,
                  ...overrides,
                  tone,
                  // Declare the client's tools natively too (plugins + toolChoice +
                  // a customInstructions nudge); the fenced-block protocol in the
                  // prompt remains the parseable path.
                  ...(toolMode
                    ? {
                        plugins: clientPlugins(input.tools ?? []),
                        toolChoice: input.toolChoice ?? null,
                        customInstructions:
                          "You have access to real tools provided by the calling application. " +
                          "Call tools directly when needed. Do not say tools are unavailable.",
                      }
                    : {}),
                })
              );
              // #10718 — the invocation and its type:1 Metrics follow-up must land
              // in ONE socket write, exactly as the browser sends them; a bare
              // invocation (or one preceded by a type:6 ping) is silently dropped.
              ws?.send(invocationFrame + metricsFrame());
            };

            ws.on("open", () => {
              log?.debug?.("M365_WS", "socket open — sending handshake");
              ws?.send(handshakeFrame());
            });

            // Fork: an HTTP rejection of the WebSocket upgrade (e.g. 429) is a real status.
            ws.on("unexpected-response", (_request, response) => {
              response.resume();
              abort(
                `Microsoft 365 Copilot WebSocket rejected (HTTP ${response.statusCode})`,
                response.statusCode === 429 ? 429 : 502,
                response.headers["retry-after"]
              );
            });

            ws.on("message", (data) => {
              if (settled) return;
              buffer += data.toString();
              const split = splitFrames(buffer);
              buffer = split.rest;
              if (abortIfBufferOverCap()) return;

              for (const rawFrame of split.frames) {
                const frame = parseFrame(rawFrame);
                log?.debug?.(
                  "M365_WS",
                  `frame type=${String(frame?.type)} target=${String(frame?.target)}`
                );
                if (!handshakeComplete) {
                  const err = handshakeError(frame);
                  if (err) {
                    clearTimeout(timeout);
                    log?.debug?.("M365_WS", `handshake failed: ${err}`);
                    abort(`Microsoft 365 Copilot handshake failed: ${err}`);
                    return;
                  }
                  handshakeComplete = true;
                  log?.debug?.("M365_WS", "handshake complete — sending chat invocation");
                  sendChat();
                  continue;
                }

                // SignalR keepalive: the server pings with type:6 and expects the
                // exact echo back, or it drops the socket mid-turn on long agentic runs.
                if (frame?.type === 6) {
                  try {
                    ws?.send(keepaliveFrame());
                  } catch {
                    /* socket already closing — the close handler finishes the stream */
                  }
                  continue;
                }

                // Fork: Microsoft reports throttling as an otherwise successful bot update
                // (or a frame-level error string); both must end the turn, not stream as text.
                const rateLimitMessage = extractM365RateLimitMessage(frame);
                if (rateLimitMessage) {
                  log?.debug?.(
                    "M365_WS",
                    "rate limit — applying local 15-minute connection cooldown"
                  );
                  abort(rateLimitMessage, 429);
                  return;
                }
                if (typeof frame?.error === "string" && frame.error) {
                  abort(`Microsoft 365 Copilot invocation failed: ${frame.error}`);
                  return;
                }

                const { delta, next } = accumulateBotContent(previousText, frame);
                if (!delta && next === previousText) {
                  // #7858 AC2/AC3 — log unrecognized-shape update frames by KEY only, so
                  // the next report ships the data needed to add a handler without a
                  // manual capture round-trip. Never log message content, tokens, cookies.
                  const shape = describeUpdateFrameShape(frame);
                  if (shape) log?.debug?.("M365_WS", `unrecognized update frame keys: ${shape}`);
                }
                previousText = next;
                if (delta) {
                  if (!toolMode) {
                    controller.enqueue(encoder.encode(sseChunk(input.model, { content: delta })));
                  } else if (!fenceSeen) {
                    // Hold back a 12-char tail so a "```" opener straddling a chunk
                    // boundary is never emitted as content; once any fence opens,
                    // buffer everything for the finish-time tool-call resolution.
                    pendingTail += delta;
                    if (pendingTail.includes("```")) {
                      fenceSeen = true;
                    } else if (pendingTail.length > 12) {
                      const cut = pendingTail.length - 12;
                      controller.enqueue(
                        encoder.encode(
                          sseChunk(input.model, { content: pendingTail.slice(0, cut) })
                        )
                      );
                      pendingTail = pendingTail.slice(cut);
                    }
                  }
                }

                const finalMsg = extractFinalResultMessage(frame);
                if (finalMsg) {
                  finalResultMessage = finalMsg;
                }

                // A type:3 carrying an error is a FAILED turn; without this it
                // would finish() into a silent empty stop.
                const completionError = extractCompletionError(frame);
                if (completionError) {
                  clearTimeout(timeout);
                  log?.debug?.("M365_WS", `completion error: ${completionError}`);
                  abort(`Microsoft 365 Copilot invocation failed: ${completionError}`);
                  return;
                }

                if (isCompletionFrame(frame)) {
                  clearTimeout(timeout);
                  finish();
                  return;
                }
              }
            });

            ws.on("error", (err) => {
              clearTimeout(timeout);
              log?.debug?.(
                "M365_WS",
                `socket error: ${err instanceof Error ? err.message : String(err)}`
              );
              abort(
                sanitizeErrorMessage(
                  err instanceof Error ? err.message : "Microsoft 365 Copilot WebSocket error"
                )
              );
            });

            ws.on("close", () => {
              clearTimeout(timeout);
              finish();
            });
          } catch (err) {
            clearTimeout(timeout);
            abort(
              sanitizeErrorMessage(
                err instanceof Error ? err.message : "Failed to connect to Microsoft 365 Copilot"
              )
            );
          }
        },
        cancel() {
          cancelChat();
        },
      },
      { highWaterMark: 16384 }
    );
  }

  /**
   * #10718 — proactively refresh the M365 access token before opening the WS.
   * A WS-handshake 401 surfaces as an error event INSIDE the SSE stream (the HTTP
   * response is already 200 by then), so chatCore's generic 401→refresh→retry
   * orchestration never triggers — the refresh has to happen here, pre-flight.
   * No-ops for legacy connections without a stored refresh_token.
   */
  private async ensureFreshCredentials(
    credentials: ExecuteInput["credentials"],
    onCredentialsRefreshed: ExecuteInput["onCredentialsRefreshed"],
    log: ExecutorLog | null
  ): Promise<void> {
    const psd = (credentials?.providerSpecificData ?? {}) as JsonRecord;
    const refreshToken =
      credentials.refreshToken || (typeof psd.refreshToken === "string" ? psd.refreshToken : "");
    if (!refreshToken) return;

    const current = currentM365AccessToken(credentials);
    if (current && !tokenNeedsRefresh(current)) return;

    const tid = decodeJwtClaims(current)?.tid || (typeof psd.tid === "string" ? psd.tid : "") || "";
    const result = await refreshM365AccessToken(refreshToken, tid, log ?? undefined);
    if ("error" in result) {
      // Fall through with the existing token — the WS layer will surface the failure.
      return;
    }

    const rotated = result.refreshToken || refreshToken;
    const chathubPath = currentM365ChathubPath(credentials);
    const assembledApiKey = chathubPath
      ? ["access_token=", result.accessToken, "; chathubPath=", chathubPath].join("")
      : "";
    const next = {
      ...credentials,
      accessToken: result.accessToken,
      refreshToken: rotated,
      // Keep the pasted-format apiKey self-consistent so every resolution path
      // (fresh column, stale column, dashboard re-read) sees the same token.
      ...(assembledApiKey ? { apiKey: assembledApiKey } : {}),
      ...(result.expiresIn
        ? { expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString() }
        : {}),
    };
    Object.assign(credentials, next);
    try {
      await onCredentialsRefreshed?.(next);
    } catch (err) {
      // #7676 pattern: a persistence failure must never fail the user-facing response.
      log?.warn?.(
        "M365_TOKEN",
        `persisting refreshed token failed (${err instanceof Error ? err.message : String(err)}) — will re-refresh next request`
      );
    }
  }

  async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const body = input.body as JsonRecord | undefined;
    const model = input.model || (body?.model as string) || "copilot-m365";
    const stream = input.stream !== false;
    // Fork: inline images are uploaded natively (copilot-m365-images.ts); an unsupported image
    // (e.g. a remote URL) is refused instead of being put in the text prompt.
    const images = extractM365Images(body);
    if ("error" in images) {
      return {
        response: errorResponse(images.error, 400),
        url: "https://substrate.office.com/m365Copilot/UploadFile",
        headers: {},
        transformedBody: null,
      };
    }
    const { tools, toolChoice } = extractToolSpec(body);
    const routerActive = tools.length > 0 && toolChoice !== "none";
    // Router planning: the router turn decides tool use; the answer turn (when the
    // router selects none) must be RE-FRAMED as an answer request — a raw history
    // continuation makes the model keep emitting the router's decision format.
    const flat = flattenMessages(body);
    const prompt =
      !flat && images.length > 0
        ? "Describe the attached image."
        : (routerActive
            ? "Please answer the following request in full, using the tool results already " +
              "provided in the conversation. Do not output tool-routing decisions.\n\n" +
              flat
            : buildPrompt(body)
          ).trim();

    if (!prompt) {
      return {
        response: errorResponse("No user message provided", 400),
        url: "wss://substrate.office.com/m365Copilot/Chathub",
        headers: {},
        transformedBody: null,
      };
    }

    await this.ensureFreshCredentials(
      input.credentials,
      input.onCredentialsRefreshed,
      input.log ?? null
    );

    const connectionParams = resolveConnectionParams(input.credentials);
    if ("error" in connectionParams) {
      return {
        response: errorResponse(connectionParams.error, 400),
        url: "wss://substrate.office.com/m365Copilot/Chathub",
        headers: {},
        transformedBody: { model, prompt: prompt.slice(0, 100) },
      };
    }

    const wsUrl = buildWsUrl(connectionParams);
    let answerWsUrl: string | null = null;

    try {
      // Fork: credentials may have been selected before another queued turn was throttled.
      // Recheck the persisted cooldown before either an image upload or a socket opens.
      if (input.credentials.connectionId) {
        const until = cooldownUntilMs(getConnectionRateLimitUntil(input.credentials.connectionId));
        if (until > Date.now()) {
          return {
            response: errorResponse(
              "Microsoft 365 Copilot is cooling down after a rate limit",
              429,
              Math.max(1, Math.ceil((until - Date.now()) / 1000))
            ),
            url: redactWsUrl(wsUrl),
            headers: {},
            transformedBody: { model },
          };
        }
      }

      // Router planning turn — ask the model as a tool-SELECTION assistant. Asking
      // it to "use" a client tool gets refused (it checks its own plugin registry);
      // printing a routing decision as text bypasses that refusal.
      if (routerActive) {
        const routerStream = await this.wsChat({
          wsUrl,
          prompt: buildRouterPrompt(flat, tools, toolChoice),
          model,
          tier: connectionParams.tier,
          connectionId: input.credentials.connectionId,
          signal: input.signal ?? undefined,
          log: input.log,
        });
        const routerText = await readSseText(routerStream);
        const decision = parseToolRouterDecision(routerText, tools, toolChoice);
        input.log?.debug?.(
          "M365_TOOLS",
          `router decided=${decision.decided} calls=${decision.calls.length}`
        );
        if (decision.decided && decision.calls.length > 0) {
          return toolCallsResult(decision.calls, { stream, model, wsUrl });
        }
        // No tool needed (or unparseable): answer in a FRESH conversation below.
        // Reusing the router's ConversationId makes the answer turn a continuation
        // of the routing dialog, and the model keeps emitting the router's decision
        // format (NO_TOOL_NEEDED) as the answer.
        answerWsUrl = buildWsUrl(connectionParams);
      }

      // Fork: images are bound to the conversation of the turn that answers, so they are
      // uploaded under the answer turn's WebSocket URL (a fresh one after router planning).
      const messageAnnotations = images.length
        ? await uploadM365Images(
            connectionParams,
            answerWsUrl ?? wsUrl,
            images,
            input.signal ?? undefined
          )
        : undefined;
      const wsStream = await this.wsChat({
        wsUrl: answerWsUrl ?? wsUrl,
        prompt,
        model,
        tier: connectionParams.tier,
        tools,
        toolChoice,
        messageAnnotations,
        connectionId: input.credentials.connectionId,
        signal: input.signal ?? undefined,
        log: input.log,
      });

      if (stream) {
        // Fork: HTTP status cannot change after streaming starts. Inspect the first event and
        // reuse the normal buffering helper so an early throttle reaches chatCore as a 429.
        const reader = wsStream.getReader();
        const first = await reader.read();
        const error = first.value ? streamError(first.value) : null;
        if (error?.status === 429) {
          await reader.cancel();
          reader.releaseLock();
          return {
            response: errorResponse(error.message, error.status, error.retryAfterSeconds),
            url: redactWsUrl(wsUrl),
            headers: {},
            transformedBody: { model },
          };
        }
        return {
          response: new Response(prependBufferedChunks(first.value ? [first.value] : [], reader), {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url: redactWsUrl(wsUrl),
          headers: {},
          transformedBody: { model, prompt: prompt.slice(0, 100) },
        };
      }

      const reader = wsStream.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      const toolCalls: Array<{
        id: string;
        type: string;
        name: string;
        arguments: string;
      }> = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Fork: an error event (empty turn, rejected invocation, throttle) is a real status.
        const error = streamError(value);
        if (error) {
          await reader.cancel();
          reader.releaseLock();
          return {
            response: errorResponse(error.message, error.status, error.retryAfterSeconds),
            url: redactWsUrl(wsUrl),
            headers: {},
            transformedBody: { model },
          };
        }
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const content = choice?.delta?.content;
            if (typeof content === "string") fullText += content;
            for (const tc of choice?.delta?.tool_calls ?? []) {
              toolCalls.push({
                id: String(tc.id ?? ""),
                type: String(tc.type ?? "function"),
                name: String(tc.function?.name ?? ""),
                arguments: String(tc.function?.arguments ?? "{}"),
              });
            }
          } catch {
            /* skip malformed SSE lines */
          }
        }
      }
      reader.releaseLock();

      // Tool-call turn: content stops at the first fence, the calls ride in
      // `tool_calls` with finish_reason "tool_calls" (OpenAI agentic-loop shape).
      if (toolCalls.length > 0) {
        const fenceIndex = fullText.indexOf("```");
        const content = fenceIndex > 0 ? fullText.slice(0, fenceIndex).trim() : null;
        return {
          response: new Response(
            JSON.stringify({
              id: `chatcmpl-copilot-m365-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content,
                    tool_calls: toolCalls.map((c) => ({
                      id: c.id,
                      type: c.type,
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }),
            { headers: { "Content-Type": "application/json" } }
          ),
          url: redactWsUrl(answerWsUrl ?? wsUrl),
          headers: {},
          transformedBody: { model, toolCalls: toolCalls.length },
        };
      }

      return {
        response: new Response(
          JSON.stringify({
            id: `chatcmpl-copilot-m365-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                // Fork: an empty turn is an error event (handled above), never a placeholder.
                message: { role: "assistant", content: fullText },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          { headers: { "Content-Type": "application/json" } }
        ),
        url: redactWsUrl(wsUrl),
        headers: {},
        transformedBody: { model, prompt: prompt.slice(0, 100) },
      };
    } catch (err) {
      const message = sanitizeErrorMessage(
        err instanceof Error ? err.message : "Microsoft 365 Copilot executor error"
      );
      // Fork: a throttled image upload is a 429 with the same local cooling period.
      const status = err instanceof M365ImageUploadError && err.status === 429 ? 429 : 502;
      const retryAfterSeconds =
        status === 429 && err instanceof M365ImageUploadError
          ? m365CoolingSeconds(err.retryAfter)
          : undefined;
      if (status === 429 && input.credentials.connectionId) {
        markConnectionRateLimitedUntil(
          input.credentials.connectionId,
          m365CoolingSeconds(err instanceof M365ImageUploadError ? err.retryAfter : undefined) *
            1000
        );
      }
      return {
        response: errorResponse(message, status, retryAfterSeconds),
        url: redactWsUrl(wsUrl),
        headers: {},
        transformedBody: { model, prompt: prompt.slice(0, 100) },
      };
    }
  }
}
