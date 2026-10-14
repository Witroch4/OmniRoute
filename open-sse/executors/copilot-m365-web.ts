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
  buildWsUrl,
  redactWsUrl,
  resolveConnectionParams,
} from "./copilot-m365-connection.ts";
import {
  accumulateBotContent,
  buildChatInvocation,
  encodeFrame,
  extractFinalResultMessage,
  extractM365RateLimitMessage,
  handshakeError,
  handshakeFrame,
  isCompletionFrame,
  metricsFrame,
  parseFrame,
  splitFrames,
} from "./copilot-m365-frames.ts";

import {
  extractM365Images,
  M365ImageUploadError,
  uploadM365Images,
  type M365ImageAnnotation,
} from "./copilot-m365-images.ts";

type JsonRecord = Record<string, unknown>;
let WebSocketCtor: typeof WebSocket = WebSocket;
// Operator protection, not a Microsoft-published reset window.
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

function sseChunk(model: string, delta: JsonRecord, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-copilot-m365-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function errorResponse(message: string, status = 502, retryAfterSeconds?: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
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

export class CopilotM365WebExecutor extends BaseExecutor {
  constructor() {
    super("copilot-m365-web", { id: "copilot-m365-web", baseUrl: "wss://substrate.office.com" });
  }

  private async wsChat(input: {
    wsUrl: string;
    prompt: string;
    model: string;
    messageAnnotations?: M365ImageAnnotation[];
    connectionId?: string;
    signal?: AbortSignal;
    log?: ExecutorLog | null;
  }): Promise<ReadableStream<Uint8Array>> {
    // #6210 — observability for the empty-response class. The access_token rides
    // in the WS query string, so every URL logged here goes through redactWsUrl().
    const log = input.log ?? null;
    let cancelChat = () => {};
    return new ReadableStream<Uint8Array>(
      {
        start: async (controller) => {
          const encoder = new TextEncoder();
          let ws: WebSocket | null = null;
          let settled = false;
          let buffer = "";
          let previousText = "";
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
            if (!previousText && !finalResultMessage) {
              abort(
                "Microsoft 365 Copilot returned no content. Check the account tier and session credential."
              );
              return;
            }
            settled = true;
            clearTimeout(timeout);
            cleanup();
            // Last-resort fallback (#6210): some EDU turns surface the answer only in the
            // type:2 invocation result. Emit it if nothing was streamed.
            if (!previousText && finalResultMessage) {
              controller.enqueue(
                encoder.encode(sseChunk(input.model, { content: finalResultMessage }))
              );
            }
            controller.enqueue(encoder.encode(sseChunk(input.model, {}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };

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

          try {
            const wsUrlParts = new URL(input.wsUrl);
            const traceId = crypto.randomUUID();
            const sessionId = wsUrlParts.searchParams.get("X-SessionId") ?? crypto.randomUUID();
            const requestId = wsUrlParts.searchParams.get("chatsessionid") ?? crypto.randomUUID();
            const conversationId =
              wsUrlParts.searchParams.get("ConversationId") ?? crypto.randomUUID();

            log?.debug?.("M365_WS", `connecting → ${redactWsUrl(input.wsUrl)}`);

            ws = new WebSocketCtor(input.wsUrl, {
              headers: {
                Origin: "https://m365.cloud.microsoft",
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
              },
            });

            const sendChat = () => {
              ws?.send(
                encodeFrame(
                  buildChatInvocation({
                    text: input.prompt,
                    traceId,
                    sessionId,
                    requestId,
                    conversationId,
                    messageAnnotations: input.messageAnnotations,
                    isStartOfSession: true,
                  })
                ) + metricsFrame()
              );
            };

            ws.on("open", () => {
              log?.debug?.("M365_WS", "socket open — sending handshake");
              ws?.send(handshakeFrame());
            });

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
                previousText = next;
                if (delta) {
                  controller.enqueue(encoder.encode(sseChunk(input.model, { content: delta })));
                }

                const finalMsg = extractFinalResultMessage(frame);
                if (finalMsg) {
                  finalResultMessage = finalMsg;
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

  async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const body = input.body as JsonRecord | undefined;
    const model = input.model || (body?.model as string) || "copilot-m365";
    const stream = input.stream !== false;
    const images = extractM365Images(body);
    if ("error" in images) {
      return {
        response: errorResponse(images.error, 400),
        url: "https://substrate.office.com/m365Copilot/UploadFile",
        headers: {},
        transformedBody: null,
      };
    }
    const prompt =
      buildPrompt(body).trim() || (images.length ? "Describe the attached image." : "");

    if (!prompt) {
      return {
        response: errorResponse("No user message provided", 400),
        url: "wss://substrate.office.com/m365Copilot/Chathub",
        headers: {},
        transformedBody: null,
      };
    }

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

    try {
      // Credentials may have been selected before another queued turn was throttled.
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
      const messageAnnotations = images.length
        ? await uploadM365Images(connectionParams, wsUrl, images, input.signal ?? undefined)
        : undefined;
      const wsStream = await this.wsChat({
        wsUrl,
        prompt,
        model,
        messageAnnotations,
        connectionId: input.credentials.connectionId,
        signal: input.signal ?? undefined,
        log: input.log,
      });

      if (stream) {
        // HTTP status cannot change after streaming starts. Inspect the first event
        // and reuse the normal buffering helper so early throttles reach chatCore as 429.
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === "string") fullText += content;
          } catch {
            /* skip malformed SSE lines */
          }
        }
      }
      reader.releaseLock();

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
