import test from "node:test";
import assert from "node:assert/strict";

import {
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
