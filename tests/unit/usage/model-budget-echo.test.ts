import test from "node:test";
import assert from "node:assert/strict";

import {
  cloneShallowForModelEcho,
  echoModelInObject,
  echoModelInSseLine,
  resolveEchoModel,
} from "../../../open-sse/services/responseModelEcho.ts";

test("a budget redirect echoes the BILLED model, not the corrupted requestedModel", () => {
  // requestedModel arrives already overwritten with the served model (see the
  // comment on resolveEchoModel); only billedModel still holds what the client sent.
  const echo = resolveEchoModel({
    echoRequestedModelName: false,
    isCodexResponsesEcho: false,
    billedModel: "claude-opus-4-8",
    requestedModel: "claude-sonnet-5",
  });
  assert.equal(echo, "claude-opus-4-8");
});

test("without a redirect the opt-in setting still governs", () => {
  assert.equal(
    resolveEchoModel({
      echoRequestedModelName: false,
      isCodexResponsesEcho: false,
      billedModel: null,
      requestedModel: "claude-opus-4-8",
    }),
    null
  );
});

test("the requested model is echoed in non-streaming JSON", () => {
  const body = { model: "claude-sonnet-5", choices: [] };
  echoModelInObject(body, "claude-opus-4-8");
  assert.equal(body.model, "claude-opus-4-8");
});

test("the requested model is echoed in an SSE chunk", () => {
  const line = echoModelInSseLine('data: {"model":"claude-sonnet-5"}', "claude-opus-4-8");
  assert.match(line, /"model":"claude-opus-4-8"/);
  assert.doesNotMatch(line, /sonnet/);
});

test("the requested model is echoed in a Responses API event", () => {
  const event = { type: "response.completed", response: { model: "claude-sonnet-5" } };
  echoModelInObject(event, "claude-opus-4-8");
  assert.equal(event.response.model, "claude-opus-4-8");
});

// Final-review Finding 1: the Anthropic Messages wire format (native /v1/messages
// passthrough, and every translator that targets Claude shape) nests the served model at
// `message.model`, a THIRD nesting the echo helper missed before this fix — this is the
// feature's canonical use case (Claude Code hitting cc/claude-opus-* redirected to
// cc/claude-sonnet-*) and the very first SSE frame of the response.
test("the requested model is echoed in an Anthropic message_start SSE frame", () => {
  const line = echoModelInSseLine(
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
    "claude-opus-4-8"
  );
  assert.match(line, /"model":"claude-opus-4-8"/);
  assert.doesNotMatch(line, /sonnet/);
});

test("the requested model is echoed in a parsed Anthropic message_start object", () => {
  const event = {
    type: "message_start",
    message: { id: "msg_1", role: "assistant", model: "claude-sonnet-5", content: [] },
  };
  echoModelInObject(event, "claude-opus-4-8");
  assert.equal(event.message.model, "claude-opus-4-8");
});

// Antigravity/cloudcode wire shape (`/antigravity` endpoint) nests the served model under
// a DIFFERENT field name (`modelVersion`, not `model`) inside the same `response` envelope
// the Responses API also uses — also missed before this fix.
test("the requested model is echoed in an Antigravity SSE frame's response.modelVersion", () => {
  const line = echoModelInSseLine(
    'data: {"response":{"candidates":[],"modelVersion":"claude-sonnet-5","responseId":"resp_1"}}',
    "claude-opus-4-8"
  );
  assert.match(line, /"modelVersion":"claude-opus-4-8"/);
  assert.doesNotMatch(line, /sonnet/);
});

// Final-review-fixes-wave-2: the native Gemini response shape nests the served model at
// the TOP level under `modelVersion` (not `model`, and NOT nested under `response` like
// the Antigravity/Responses-API shapes above) — `{ candidates, usageMetadata,
// modelVersion }`. Reachable via the passthrough branch when clientResponseFormat ===
// GEMINI (chatCore.ts), in practice the Ollama shim (/v1/api/chat) carrying a
// hand-crafted Gemini body against a Gemini-target provider. This was the one shape
// still missed after Finding 1's fix.
test("the requested model is echoed in a Gemini native SSE frame's top-level modelVersion", () => {
  const line = echoModelInSseLine(
    'data: {"candidates":[],"usageMetadata":{},"modelVersion":"claude-sonnet-5"}',
    "claude-opus-4-8"
  );
  assert.match(line, /"modelVersion":"claude-opus-4-8"/);
  assert.doesNotMatch(line, /sonnet/);
});

test("the requested model is echoed in a parsed Gemini native object's top-level modelVersion", () => {
  const event = { candidates: [], usageMetadata: {}, modelVersion: "claude-sonnet-5" };
  echoModelInObject(event, "claude-opus-4-8");
  assert.equal(event.modelVersion, "claude-opus-4-8");
});

test("a payload with no model field at all is left byte-identical", () => {
  const line = 'data: {"foo":"bar","id":"chatcmpl-1"}';
  assert.equal(echoModelInSseLine(line, "claude-opus-4-8"), line);

  const obj = { foo: "bar", id: "chatcmpl-1" };
  const before = JSON.stringify(obj);
  echoModelInObject(obj, "claude-opus-4-8");
  assert.equal(JSON.stringify(obj), before);
});

test("cloneShallowForModelEcho isolates top-level modelVersion the same way it isolates top-level model", () => {
  const cached = { candidates: [], usageMetadata: {}, modelVersion: "claude-sonnet-5" };
  const clone = cloneShallowForModelEcho(cached);
  echoModelInObject(clone, "claude-opus-4-8");
  assert.equal(clone.modelVersion, "claude-opus-4-8");
  // The shared cached entry must be untouched for the next reader.
  assert.equal(cached.modelVersion, "claude-sonnet-5");
});
