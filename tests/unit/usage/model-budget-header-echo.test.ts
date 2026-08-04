// Round-1 review fix: X-OmniRoute-Model / X-OmniRoute-Provider (and, for the
// non-streaming path, X-OmniRoute-Response-Cost) must carry the BILLED pair on a
// redirected request, not the served pair — otherwise the header contradicts the
// response body (which resolveEchoModel already forces to the billed pair),
// and the mismatch is itself an observable tell.
//
// This exercises the REAL production seam: resolveEchoHeaderValue (the pure
// redirect-preference decision, open-sse/services/responseModelEcho.ts) chained
// into the REAL header builders (open-sse/handlers/chatCore/nonStreamingResponseHeaders.ts
// and .../streamingResponseHeaders.ts) exactly the way chatCore.ts calls them at
// both header call sites — not a re-implementation of either.
import test from "node:test";
import assert from "node:assert/strict";

import {
  isModelBudgetRedirect,
  resolveEchoHeaderValue,
} from "../../../open-sse/services/responseModelEcho.ts";
import { buildNonStreamingResponseHeaders } from "../../../open-sse/handlers/chatCore/nonStreamingResponseHeaders.ts";
import { assembleStreamingResponseHeaders } from "../../../open-sse/handlers/chatCore/streamingResponseHeaders.ts";

function makeMetaSpy() {
  const calls: Array<{ meta: Record<string, unknown> }> = [];
  const attachOmniRouteMetaHeaders = (
    headers: Record<string, string>,
    meta: Record<string, unknown>
  ) => {
    calls.push({ meta });
    headers["x-omniroute-meta"] = "attached";
  };
  return { attachOmniRouteMetaHeaders, calls };
}

test("isModelBudgetRedirect: true only for a non-empty billedModel string", () => {
  assert.equal(isModelBudgetRedirect("claude-opus-4-8"), true);
  assert.equal(isModelBudgetRedirect(null), false);
  assert.equal(isModelBudgetRedirect(undefined), false);
  assert.equal(isModelBudgetRedirect(""), false);
});

test("resolveEchoHeaderValue: billed wins on a redirect, served passes through otherwise", () => {
  assert.equal(resolveEchoHeaderValue("claude-sonnet-5", "claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(resolveEchoHeaderValue("claude-sonnet-5", null), "claude-sonnet-5");
  assert.equal(resolveEchoHeaderValue("claude-sonnet-5", undefined), "claude-sonnet-5");
});

test("non-streaming header builder: a redirect reports the BILLED model/provider, not the served pair", () => {
  const { attachOmniRouteMetaHeaders, calls } = makeMetaSpy();
  const servedProvider = "cheap-provider";
  const servedModel = "claude-sonnet-5";
  const billedProvider = "anthropic";
  const billedModel = "claude-opus-4-8";

  buildNonStreamingResponseHeaders(
    {
      // This mirrors the real chatCore.ts call site: resolveEchoHeaderValue decides
      // the pair BEFORE it reaches the builder.
      provider: resolveEchoHeaderValue(servedProvider, billedProvider),
      model: resolveEchoHeaderValue(servedModel, billedModel),
      startTime: 0,
      responseUsage: { prompt_tokens: 10, completion_tokens: 5 },
      estimatedCost: 0.001,
      requestId: "req-1",
      compressionResponseMeta: undefined,
    },
    { attachOmniRouteMetaHeaders, now: () => 100 }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.provider, billedProvider);
  assert.equal(calls[0].meta.model, billedModel);
  assert.notEqual(calls[0].meta.model, servedModel);
  assert.notEqual(calls[0].meta.provider, servedProvider);
});

test("non-streaming header builder: without a redirect, the served pair is unchanged (byte-identical)", () => {
  const { attachOmniRouteMetaHeaders, calls } = makeMetaSpy();
  const servedProvider = "openai";
  const servedModel = "gpt-x";

  buildNonStreamingResponseHeaders(
    {
      provider: resolveEchoHeaderValue(servedProvider, null),
      model: resolveEchoHeaderValue(servedModel, null),
      startTime: 0,
      responseUsage: null,
      estimatedCost: 0,
      requestId: "req-2",
      compressionResponseMeta: undefined,
    },
    { attachOmniRouteMetaHeaders, now: () => 100 }
  );

  assert.equal(calls[0].meta.provider, servedProvider);
  assert.equal(calls[0].meta.model, servedModel);
});

test("streaming header builder: a redirect reports the BILLED model/provider, not the served pair", () => {
  const calls: Array<{ meta: Record<string, unknown> }> = [];
  const build = (_headers: unknown, meta: Record<string, unknown>) => {
    calls.push({ meta });
    return { "x-upstream": "kept" };
  };
  const servedProvider = "cheap-provider";
  const servedModel = "claude-sonnet-5";
  const billedProvider = "anthropic";
  const billedModel = "claude-opus-4-8";

  assembleStreamingResponseHeaders(
    {
      providerHeaders: new Headers({ "content-type": "text/event-stream" }),
      provider: resolveEchoHeaderValue(servedProvider, billedProvider),
      model: resolveEchoHeaderValue(servedModel, billedModel),
      pendingRequestId: "preq-1",
      compressionResponseMeta: undefined,
    },
    build as Parameters<typeof assembleStreamingResponseHeaders>[1]
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.provider, billedProvider);
  assert.equal(calls[0].meta.model, billedModel);
});
