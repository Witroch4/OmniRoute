/**
 * Microsoft 365 Copilot (BizChat / Substrate) SignalR-over-WebSocket framing.
 *
 * Pure, transport-free helpers that translate between the OpenAI chat shape and
 * the Substrate BizChat SignalR JSON protocol observed on the individual M365
 * path (`m365.cloud.microsoft/chat` → `wss://substrate.office.com/m365Copilot/
 * Chathub/...`). Keeping these pure lets us unit-test the wire format against the
 * real frame captures contributed in #4042 without opening a live socket — the
 * live round-trip is the separate Rule #18 validation gate for the executor.
 *
 * Protocol (from @skyzea1's #4042 capture):
 *   - JSON messages terminated with the SignalR record separator `\x1e`.
 *   - Handshake: → {"protocol":"json","version":1}  ← {}  → {"type":6}
 *   - Send: type:4 invocation to target "chat" with arguments[0] = { message, ... }
 *   - Stream: type:1 target:"update" deltas (bot text at arguments[0].messages[].text,
 *     accumulated — NOT incremental) → isLastUpdate:true → type:2 final → type:3 completion.
 */

/** SignalR record separator (0x1e) terminating every JSON frame. */
export const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/** SignalR handshake request — the first frame the client must send. */
export const HANDSHAKE_REQUEST = { protocol: "json", version: 1 } as const;

/** SignalR keepalive ping frame. */
export const KEEPALIVE_PING = { type: 6 } as const;

/** Consumer wire contract from the upstream #11069 browser capture. */
export const ALLOWED_MESSAGE_TYPES = [
  "Chat",
  "Suggestion",
  "InternalSearchQuery",
  "Disengaged",
  "InternalLoaderMessage",
  "Progress",
  "GeneratedCode",
  "RenderCardRequest",
  "AdsQuery",
  "SemanticSerp",
  "GenerateContentQuery",
  "GenerateGraphicArt",
  "SearchQuery",
  "ConfirmationCard",
  "AuthError",
  "DeveloperLogs",
  "TriggerPlugin",
  "HintInvocation",
  "MemoryUpdate",
  "EndOfRequest",
  "TriggerConfirmation",
  "ResumeInvokeAction",
  "ResumeUserInputRequest",
  "TriggerUserInputRequest",
  "EscapeHatch",
  "TriggerPluginAuth",
  "ResumePluginAuth",
  "SideBySide",
  "ReferencesListComplete",
  "SwitchRespondingEndpoint",
] as const;

export const M365_DEFAULT_OPTION_SETS = [
  "search_result_progress_messages_with_search_queries",
  "update_textdoc_response_after_streaming",
  "deepleo_networking_timeout_10minutes_canmore",
  "cwc_flux_image",
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwcfluxgptv",
  "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
  "gptvnorm2048",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "cwc_code_interpreter_interactive_charts_inline_image",
  "code_interpreter_matplotlib_patching",
  "cwc_fileupload_odb",
  "update_memory_plugin",
  "add_custom_instructions",
  "cwc_flux_v3",
  "flux_v3_progress_messages",
  "enable_batch_token_processing",
  "enable_gg_gpt",
  "async_client_interaction",
  "flux_v3_references",
  "flux_v3_references_entities",
  "flux_v3_references_ci",
  "add_filestore_filetype",
  "cwc_code_interpreter_citation_sourceannotations",
  "cdxcwc_code_interpreter_hallucinated_url_filter",
  "flux_v3_image_gen_enable_dimensions",
  "flux_v3_image_gen_enable_non_watermarked_storage",
  "flux_v3_image_gen_enable_icon_dimensions",
  "flux_v3_image_gen_enable_system_text_with_params",
  "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
  "flux_v3_image_gen_enable_story",
  "rich_responses",
] as const;

/** Append the record separator to a JSON-serializable frame. */
export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj) + RECORD_SEPARATOR;
}

/** Serialized handshake request frame. */
export function handshakeFrame(): string {
  return encodeFrame(HANDSHAKE_REQUEST);
}

/** Serialized keepalive ping frame. */
export function keepaliveFrame(): string {
  return encodeFrame(KEEPALIVE_PING);
}

/** The chat invocation and Metrics follow-up share one socket write (#10732). */
export function metricsFrame(): string {
  return encodeFrame({
    arguments: [
      {
        Timestamps: {
          ConnectionEstablished: "",
          ConnectionStart: "",
          UserInputStart: "",
          UserInputSubmit: "",
        },
      },
    ],
    target: "Metrics",
    type: 1,
  });
}

/**
 * Split a raw socket buffer into complete `\x1e`-terminated frames, returning any
 * trailing partial frame as `rest` so it can be prepended to the next chunk.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(RECORD_SEPARATOR);
  // The last element is either "" (buffer ended on a separator) or a partial frame.
  const rest = parts.pop() ?? "";
  const frames = parts.filter((p) => p.length > 0);
  return { frames, rest };
}

/** Safely JSON.parse a single frame body; returns null on malformed input. */
export function parseFrame(frame: string): Record<string, unknown> | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A SignalR handshake response is `{}` on success, or `{ error: "..." }` on
 * failure. Returns the error string, or null when the handshake succeeded.
 */
export function handshakeError(frame: Record<string, unknown> | null): string | null {
  if (!frame) return null;
  const err = frame.error;
  return typeof err === "string" && err.length > 0 ? err : null;
}

export interface ChatInvocationOptions {
  text: string;
  /** Per-invocation trace id. */
  traceId: string;
  /** Per-session id (GUID). */
  sessionId: string;
  /** Must match chatsessionid and ConversationId in the WebSocket URL. */
  requestId: string;
  conversationId: string;
  messageAnnotations?: import("./copilot-m365-images.ts").M365ImageAnnotation[];
  /** Whether this is the first turn of the conversation. */
  isStartOfSession?: boolean;
  /** Optional override of the consumer option flags. */
  optionsSets?: string[];
  tone?: string;
}

/**
 * Build the `type:4` chat invocation frame body (not yet `\x1e`-terminated).
 * Matches the consumer capture in upstream #10732 / #11069. The legacy
 * #4042 payload handshakes successfully but is rejected by the hub.
 */
export function buildChatInvocation(opts: ChatInvocationOptions): Record<string, unknown> {
  const clientInfo = {
    clientAppName: "Office",
    clientPlatform: "mcmcopilot-web",
    clientEntrypoint: "mcmcopilot-officeweb",
    clientSessionId: opts.sessionId,
    ProductCategory: "Chat",
    clientAppType: "Web",
    productEntryPoint: "ChatPanel",
    deviceOS: "Windows",
    deviceType: "Desktop",
    clientPlatformVersion: "10",
  };
  return {
    type: 4,
    target: "chat",
    invocationId: "0",
    arguments: [
      {
        source: "officeweb",
        clientCorrelationId: opts.traceId,
        conversationId: opts.conversationId,
        sessionId: opts.sessionId,
        optionsSets: opts.optionsSets ?? [...M365_DEFAULT_OPTION_SETS],
        streamingMode: "ConciseWithPadding",
        options: {},
        extraExtensionParameters: {},
        allowedMessageTypes: [...ALLOWED_MESSAGE_TYPES],
        sliceIds: [],
        threadLevelGptId: {},
        traceId: opts.traceId,
        isStartOfSession: opts.isStartOfSession ?? true,
        clientInfo,
        message: {
          adaptiveCards: [],
          attachments: null,
          clientInfo,
          clientPreferences: {},
          connectedFederatedConnections: ["dummyId"],
          entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
          experienceType: "Default",
          locale: "en-us",
          locationInfo: { timeZone: "UTC", timeZoneOffset: 0 },
          requestId: opts.requestId,
          author: "user",
          inputMethod: "Keyboard",
          text: opts.text,
          messageType: "Chat",
          ...(opts.messageAnnotations?.length
            ? { messageAnnotations: opts.messageAnnotations }
            : {}),
        },
        plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }],
        productThreadType: "Office",
        isSbsSupported: true,
        tone: opts.tone ?? "Magic",
        toolChoice: null,
        renderReferencesBehindEOS: true,
        disconnectBehavior: "continue",
      },
    ],
  };
}

/** True when the frame is a SignalR invocation/streamItem (`type:1`) update. */
export function isUpdateFrame(frame: Record<string, unknown> | null): boolean {
  return !!frame && frame.type === 1 && frame.target === "update";
}

/** True when the frame is the SignalR completion (`type:3`) for the chat invocation. */
export function isCompletionFrame(frame: Record<string, unknown> | null): boolean {
  return !!frame && frame.type === 3;
}

/** True when an update frame is flagged as the last update of the turn. */
export function isLastUpdate(frame: Record<string, unknown> | null): boolean {
  if (!isUpdateFrame(frame)) return false;
  const args = (frame as Record<string, unknown>).arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  return first?.isLastUpdate === true;
}

/**
 * Extract the accumulated bot text from a `type:1` update frame, reading the last
 * bot-authored message's `.text`. Returns null when the frame carries no bot text
 * (Progress/Suggestion/ReferencesListComplete updates, throttling-only frames, etc.).
 */
export function extractBotText(frame: Record<string, unknown> | null): string | null {
  if (!isUpdateFrame(frame)) return null;
  const args = (frame as Record<string, unknown>).arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  const messages = first?.messages;
  if (!Array.isArray(messages)) return null;
  // Prefer the last bot-authored message with non-empty text.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m) continue;
    const author = m.author;
    const text = m.text;
    if (m.messageType === "Progress" || m.contentType === "EarlyProgress") continue;
    if ((author === "bot" || author === undefined) && typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return null;
}

/**
 * BizChat update frames carry the FULL accumulated answer each time, not an
 * incremental delta. Given the previously-emitted text and the new accumulated
 * text, return the new suffix to stream. When the new text does not extend the
 * previous (a replace/rewrite), the whole new text is returned so nothing is lost.
 */
export function incrementalDelta(previous: string, next: string): string {
  if (!next) return "";
  if (next === previous) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

/**
 * Extract an incremental `writeAtCursor` delta from a `type:1` update frame. The EDU /
 * GPT-5.5 path (`OfficeWebIncludedCopilot`, feature.bizchatfluxv3) streams response text
 * as `arguments[0].writeAtCursor` INCREMENTS instead of only accumulated `messages[].text`
 * snapshots. Returns null when the frame carries no writeAtCursor delta. (#6210)
 */
export function extractWriteAtCursor(frame: Record<string, unknown> | null): string | null {
  if (!isUpdateFrame(frame)) return null;
  const args = (frame as Record<string, unknown>).arguments;
  const first = Array.isArray(args) ? (args[0] as Record<string, unknown> | undefined) : undefined;
  const wac = first?.writeAtCursor;
  return typeof wac === "string" && wac.length > 0 ? wac : null;
}

/**
 * Extract the final answer from a `type:2` invocation-result frame
 * (`item.result.message`). Used as a last-resort fallback when a turn emitted no
 * streamed content (some EDU turns only surface the answer here). (#6210)
 */
export function extractFinalResultMessage(frame: Record<string, unknown> | null): string | null {
  if (!frame || frame.type !== 2) return null;
  const item = frame.item as Record<string, unknown> | undefined;
  const result = item?.result as Record<string, unknown> | undefined;
  const message = result?.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * Fold a single incoming frame into the running bot answer, returning the suffix to
 * stream (`delta`) and the new accumulated text (`next`). Handles both wire formats:
 * `messages[].text` snapshots are the full accumulated answer (diffed via
 * {@link incrementalDelta}), while `writeAtCursor` frames are incremental and are
 * appended. Non-content frames leave the state unchanged. (#6210)
 */
export function accumulateBotContent(
  previous: string,
  frame: Record<string, unknown> | null
): { delta: string; next: string } {
  const snapshot = extractBotText(frame);
  if (snapshot) {
    return { delta: incrementalDelta(previous, snapshot), next: snapshot };
  }
  const wac = extractWriteAtCursor(frame);
  if (wac) {
    return { delta: wac, next: previous + wac };
  }
  return { delta: "", next: previous };
}
