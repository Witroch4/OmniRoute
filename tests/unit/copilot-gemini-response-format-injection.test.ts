import assert from "node:assert/strict";
import test from "node:test";

const { GithubExecutor } = await import("../../open-sse/executors/github.ts");

const SCHEMA = {
  type: "object",
  properties: { headline: { type: "string" }, cta: { type: "string" } },
  required: ["headline", "cta"],
  additionalProperties: false,
};

function jsonSchemaRequest() {
  return {
    messages: [{ role: "user", content: "crie um post" }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "post", strict: true, schema: SCHEMA },
    },
  };
}

// Copilot's own GET /models reports capabilities.supports.structured_outputs for
// every family EXCEPT gemini-*, whose entries omit the flag entirely. The Gemini
// endpoints answer 200 and ignore response_format instead of rejecting it, so the
// caller silently receives prose where a schema was requested.
for (const model of [
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
]) {
  test(`Copilot ${model}: json_schema becomes a system instruction and the field is dropped`, () => {
    const executor = new GithubExecutor();
    const transformed = executor.transformRequest(model, jsonSchemaRequest(), false, {});

    assert.equal(
      transformed.response_format,
      undefined,
      "response_format must not reach a model that ignores it"
    );
    assert.equal(transformed.messages[0].role, "system");
    assert.match(
      transformed.messages[0].content,
      /Respond only with valid JSON matching this schema/i
    );
    assert.match(transformed.messages[0].content, /"headline"/);
    assert.match(transformed.messages[0].content, /"cta"/);
  });
}

test("Copilot gemini: json_object also gets the prompt fallback", () => {
  const executor = new GithubExecutor();
  const transformed = executor.transformRequest(
    "gemini-3.7-flash",
    {
      messages: [{ role: "user", content: "oi" }],
      response_format: { type: "json_object" },
    },
    false,
    {}
  );

  assert.equal(transformed.response_format, undefined);
  assert.match(transformed.messages[0].content, /Respond only with valid JSON\./i);
});

test("supportsNativeResponseFormat marks gemini/claude as guests, OpenAI-family as native", () => {
  const executor = new GithubExecutor();

  for (const m of ["gemini-3.7-flash", "claude-sonnet-5", "claude-opus-5"]) {
    assert.equal(executor.supportsNativeResponseFormat(m), false, m);
  }
  // structured_outputs: true on this account's live Copilot catalog.
  for (const m of ["gpt-5.6-luna", "gpt-5.4", "grok-4.6", "kimi-k2.7-code", "mai-code-1.1-flash"]) {
    assert.equal(executor.supportsNativeResponseFormat(m), true, m);
  }
});

test("regression: Claude keeps the injection path it has always used", () => {
  const executor = new GithubExecutor();
  const transformed = executor.transformRequest("claude-sonnet-5", jsonSchemaRequest(), false, {});

  assert.equal(transformed.response_format, undefined);
  assert.match(
    transformed.messages[0].content,
    /Respond only with valid JSON matching this schema/i
  );
});

test("regression: OpenAI-family models still forward response_format untouched", () => {
  const executor = new GithubExecutor();
  const req = jsonSchemaRequest();
  const transformed = executor.transformRequest("gpt-5.6-luna", req, false, {});

  assert.deepEqual(transformed.response_format, req.response_format);
  assert.equal(transformed.messages[0].role, "user");
});

test("no response_format: gemini request is left alone (no phantom system message)", () => {
  const executor = new GithubExecutor();
  const transformed = executor.transformRequest(
    "gemini-3.7-flash",
    { messages: [{ role: "user", content: "oi" }] },
    false,
    {}
  );

  assert.equal(transformed.messages.length, 1);
  assert.equal(transformed.messages[0].role, "user");
});
