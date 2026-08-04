/**
 * #1311: echo the client-requested model/alias name back in the response.
 *
 * When a request uses an alias or combo (e.g. `claude-sonnet-cx` → `cx/gpt-5.5`),
 * OmniRoute forwards the upstream model name (`gpt-5.5`) in the response `model`
 * field. Strict clients (e.g. Claude Desktop) validate that the response model
 * matches the request and reject the mismatch with a 401. This opt-in helper
 * rewrites the `model` field back to the name the client asked for.
 *
 * The behavior is gated by a global setting (`echoRequestedModelName`, default off),
 * so the default response stays byte-for-byte unchanged.
 */

/**
 * True when a model budget rule redirected this request. `billedModel` is captured
 * exactly once, on the first ladder hop, and never overwritten afterward (see the
 * doc comment on {@link resolveEchoModel} for the full chain of custody). Both
 * {@link resolveEchoModel} (response body) and {@link resolveEchoHeaderValue}
 * (response headers/cost) key off this same signal, so body and headers can never
 * disagree about whether a redirect happened.
 */
export function isModelBudgetRedirect(
  billedModel: string | null | undefined
): billedModel is string {
  return typeof billedModel === "string" && billedModel.length > 0;
}

/**
 * Decide which model id the response must report.
 *
 * A model budget redirect always echoes the requested model, regardless of the
 * opt-in `echoRequestedModelName` setting: confidentiality is a hard requirement
 * (see docs spec 2026-08-03), so the client must never learn which model
 * actually served it. Without a redirect, the pre-existing rule is unchanged —
 * the opt-in setting or a Codex Responses client.
 */
export function resolveEchoModel(opts: {
  echoRequestedModelName: boolean;
  isCodexResponsesEcho: boolean;
  billedModel: string | null | undefined;
  requestedModel: unknown;
}): string | null {
  // On a budget redirect, `requestedModel` is NOT trustworthy: Task 6 mutates
  // body.model in chat.ts BEFORE chatCore derives requestedModel from it
  // (requestSetup.ts:48), so requestedModel already holds the SERVED model.
  // Echoing it would report the cheap model to the client — the exact leak this
  // feature exists to prevent. `billedModel` is by definition the pair the client
  // asked for, captured on the first hop and never overwritten, so it is the only
  // honest source here.
  if (isModelBudgetRedirect(opts.billedModel)) return opts.billedModel;
  const requestedModel = typeof opts.requestedModel === "string" ? opts.requestedModel : "";
  if (!requestedModel) return null;
  return opts.echoRequestedModelName || opts.isCodexResponsesEcho ? requestedModel : null;
}

/**
 * Resolve which model/provider id the `X-OmniRoute-Model` / `X-OmniRoute-Provider`
 * response headers must report on a possibly-redirected request.
 *
 * Unconditional — NOT gated by `echoRequestedModelName` — because
 * {@link resolveEchoModel}'s redirect branch is also unconditional: on a redirect,
 * the response BODY's `model` is forced to the billed value regardless of the
 * opt-in setting (confidentiality is a hard requirement, not an opt-in feature).
 * The #6426 invariant requires the header and the body `model` to always agree,
 * so these headers must follow the same unconditional rule — otherwise a
 * redirected request would show a body that says one model (billed) and a
 * header that says another (served), which is itself the tell this function
 * exists to close.
 *
 * Without a redirect (`billed` unset), this is a no-op: `served` passes through
 * untouched, so a request that never redirected stays byte-identical.
 */
export function resolveEchoHeaderValue(
  served: string | null | undefined,
  billed: string | null | undefined
): string | null | undefined {
  return isModelBudgetRedirect(billed) ? billed : served;
}

/**
 * Rewrite the top-level `model` field of a parsed response object (Chat Completions
 * JSON or an OpenAI SSE chunk) to `echoModel`. Mutates and returns `obj`. No-op when
 * `echoModel` is falsy or `obj` has no string `model` field.
 *
 * #3697: the Responses API nests `model` one level down — `{ type: "response.completed",
 * response: { model, ... } }` — so also rewrite `obj.response.model` when present. This is
 * what lets the Codex CLI compatibility shim echo the requested effort-suffixed model id
 * (e.g. `gpt-5.5-xhigh`) in `response.created`/`response.completed` payloads.
 */
export function echoModelInObject(obj: unknown, echoModel: string | null | undefined): unknown {
  if (!echoModel) return obj;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.model === "string") {
      rec.model = echoModel;
    }
    const nested = rec.response;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRec = nested as Record<string, unknown>;
      if (typeof nestedRec.model === "string") {
        nestedRec.model = echoModel;
      }
    }
  }
  return obj;
}

/**
 * Rewrite the `model` field inside a single SSE line. Only `data: {json}` lines that
 * carry a string `model` are rewritten; `data: [DONE]`, comments, event lines, and
 * unparseable payloads pass through untouched.
 */
export function echoModelInSseLine(line: string, echoModel: string | null | undefined): string {
  if (!echoModel) return line;
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]" || payload[0] !== "{") return line;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    let changed = false;
    if (typeof parsed.model === "string") {
      parsed.model = echoModel;
      changed = true;
    }
    // #3697: Responses API events nest `model` under `response.model` — see
    // echoModelInObject for the shape.
    const nested = parsed.response;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRec = nested as Record<string, unknown>;
      if (typeof nestedRec.model === "string") {
        nestedRec.model = echoModel;
        changed = true;
      }
    }
    if (!changed) return line;
    return `data: ${JSON.stringify(parsed)}`;
  } catch {
    return line;
  }
}

/**
 * A TransformStream that rewrites the `model` field in every SSE `data:` chunk of a
 * UTF-8 byte stream to `echoModel`. Buffers across chunk boundaries so a `data:` frame
 * split across two reads is still rewritten correctly. Used as the final pipe stage of
 * the streaming response when the echo setting is on.
 */
export function createModelEchoTransform(echoModel: string | null | undefined): TransformStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Emit complete lines; keep the trailing partial line in the buffer.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const ready = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      const rewritten = ready
        .split("\n")
        .map((line) => echoModelInSseLine(line, echoModel))
        .join("\n");
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      const tail = buffer + decoder.decode();
      if (tail) controller.enqueue(encoder.encode(echoModelInSseLine(tail, echoModel)));
    },
  });
}
