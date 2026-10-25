/**
 * Fork — an upstream error that the provider-execution pipeline hands back to the
 * non-streaming leg must reach the client in OmniRoute's sanitized error envelope.
 *
 * Since #12867 the pipeline owns the first non-streaming send, and its error outcome carries
 * the RAW upstream `Response`; the leg returned that object as the client response, so the
 * envelope `createErrorResult()` had just built (and the recursive sanitizer behind it) never
 * reached the client. Production, 2026-10-25: OpenCode Go answered a json_schema request to
 * deepseek-v4.1-flash with `400 {"model":"deepseek-v4.1-flash"}`, and the caller received that
 * body verbatim — no `error` object at all — while the streaming path, which re-parses the
 * same response, answered `{"error":{"message":"[400]: Upstream error: 400",…},
 * "upstream_details":{"model":"deepseek-v4.1-flash"}}`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runNonStreamingProviderLeg } from "../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { baseInput, makeResponse } from "./_helpers/nonStreamingProviderLegFixtures.ts";

function pipelineError(
  upstreamBody: object,
  status: number,
  headers: Record<string, string> = {},
  error = `Upstream error: ${status}`
) {
  const response = makeResponse(upstreamBody, status, headers);
  return async () => ({
    kind: "error" as const,
    result: {
      success: false as const,
      status,
      response,
      error,
      rawMessage: error,
      upstreamErrorBody: upstreamBody,
      upstreamHeaders: response.headers,
    },
    providerUsage: null,
    model: "deepseek-v4.1-flash",
    connectionId: "go-main",
  });
}

async function clientBody(result: Awaited<ReturnType<typeof runNonStreamingProviderLeg>>) {
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("expected an error leg");
  return {
    status: result.result.response.status,
    headers: result.result.response.headers,
    body: JSON.parse(await result.result.response.text()) as Record<string, unknown>,
  };
}

test("an upstream 400 without an error field reaches the client as an error envelope", async () => {
  const result = await runNonStreamingProviderLeg(
    baseInput({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      runProviderExecution: pipelineError({ model: "deepseek-v4.1-flash" }, 400),
    })
  );
  const { status, body } = await clientBody(result);
  assert.equal(status, 400);
  const error = body.error as Record<string, unknown> | undefined;
  assert.equal(typeof error?.message, "string");
  assert.match(String(error?.message), /400/);
  assert.deepEqual(body.upstream_details, { model: "deepseek-v4.1-flash" });
});

test("the upstream body is sanitized, never relayed raw", async () => {
  const result = await runNonStreamingProviderLeg(
    baseInput({
      provider: "opencode-go",
      runProviderExecution: pipelineError(
        {
          error: {
            message: "invalid request",
            trace: "Error: boom\n    at /app/node_modules/provider/index.js:10:5",
          },
          authorization: "Bearer sk-live-abcdefghijklmnop",
        },
        400,
        {},
        "invalid request"
      ),
    })
  );
  const { body } = await clientBody(result);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /node_modules/);
  assert.doesNotMatch(text, /sk-live-abcdefghijklmnop/);
  assert.equal((body.error as Record<string, unknown>).message, "[400]: invalid request");
});

test("an upstream Retry-After survives the rebuilt response", async () => {
  const result = await runNonStreamingProviderLeg(
    baseInput({
      provider: "opencode-go",
      runProviderExecution: pipelineError(
        { error: { message: "rate limited" } },
        429,
        { "retry-after": "30" },
        "rate limited"
      ),
    })
  );
  const { status, headers } = await clientBody(result);
  assert.equal(status, 429);
  assert.equal(headers.get("retry-after"), "30");
});

test("a Claude-format client keeps the upstream error wording (passthrough contract)", async () => {
  const anthropicError = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "thinking.type.enabled is not supported for this model",
    },
  };
  const result = await runNonStreamingProviderLeg(
    baseInput({
      provider: "github",
      sourceFormat: FORMATS.CLAUDE,
      runProviderExecution: pipelineError(
        anthropicError,
        400,
        {},
        "thinking.type.enabled is not supported for this model"
      ),
    })
  );
  const { status, body } = await clientBody(result);
  assert.equal(status, 400);
  assert.equal(body.type, "error");
  assert.equal(
    (body.error as Record<string, unknown>).message,
    "thinking.type.enabled is not supported for this model"
  );
});
