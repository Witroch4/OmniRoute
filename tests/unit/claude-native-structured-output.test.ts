import assert from "node:assert/strict";
import test from "node:test";

const { toAnthropicOutputFormatSchema } =
  await import("../../open-sse/translator/request/anthropicOutputFormat.ts");
const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");

const SIMPLE = {
  type: "object",
  properties: { headline: { type: "string" }, cta: { type: "string" } },
  required: ["headline", "cta"],
  additionalProperties: false,
};

function requestWith(responseFormat: unknown, extra: Record<string, unknown> = {}) {
  return openaiToClaudeRequest(
    "claude-sonnet-5",
    {
      messages: [{ role: "user", content: "crie um post" }],
      max_tokens: 300,
      response_format: responseFormat,
      ...extra,
    },
    false
  );
}

function jsonSchemaFormat(schema: unknown) {
  return {
    type: "json_schema",
    json_schema: { name: "post", strict: true, schema },
  };
}

function systemText(result: { system?: unknown }): string {
  const s = result.system;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) {
    return s
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : String(p)))
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------- normalizer

test("normalizer forces additionalProperties:false on every object node", () => {
  const out = toAnthropicOutputFormatSchema({
    type: "object",
    properties: {
      nested: {
        type: "object",
        properties: { n: { type: "string" } },
        required: ["n"],
      },
      list: {
        type: "array",
        items: {
          type: "object",
          properties: { m: { type: "string" } },
          required: ["m"],
        },
      },
    },
    required: ["nested", "list"],
  });

  assert.ok(out);
  assert.equal(out.additionalProperties, false);
  const props = out.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.nested.additionalProperties, false);
  assert.equal(
    (props.list.items as Record<string, unknown>).additionalProperties,
    false,
    "objects inside arrays need it too"
  );
});

test("normalizer preserves everything the upstream was measured to accept", () => {
  const schema = {
    type: "object",
    title: "Post",
    description: "um post",
    $defs: {
      Item: {
        type: "object",
        properties: { n: { type: "string" } },
        required: ["n"],
      },
    },
    properties: {
      headline: {
        type: "string",
        minLength: 2,
        maxLength: 80,
        pattern: "^.+$",
      },
      when: { type: "string", format: "date-time" },
      kind: { type: "string", enum: ["a", "b"] },
      optional: { anyOf: [{ type: "string" }, { type: "null" }] },
      tags: { type: "array", items: { type: "string" }, minItems: 1 },
      item: { $ref: "#/$defs/Item" },
      withDefault: { type: "string", default: "x" },
    },
    required: ["headline"],
  };

  const out = toAnthropicOutputFormatSchema(schema);
  assert.ok(out);
  const props = out.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.headline.minLength, 2);
  assert.equal(props.headline.pattern, "^.+$");
  assert.equal(props.when.format, "date-time");
  assert.deepEqual(props.kind.enum, ["a", "b"]);
  assert.ok(Array.isArray(props.optional.anyOf));
  assert.equal(props.tags.minItems, 1);
  assert.equal(props.item.$ref, "#/$defs/Item");
  assert.equal(props.withDefault.default, "x");
  assert.equal(out.title, "Post");
});

// The upstream answers 400 "For 'number' type, property 'minimum' is not
// supported". Dropping the bound silently would change the caller's contract,
// so the schema is declared incompatible and the prompt path keeps it intact.
for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "multipleOf"]) {
  test(`normalizer rejects '${keyword}' rather than dropping it`, () => {
    const out = toAnthropicOutputFormatSchema({
      type: "object",
      properties: { score: { type: "integer", [keyword]: 1 } },
      required: ["score"],
      additionalProperties: false,
    });
    assert.equal(out, null);
  });
}

test("normalizer finds an unsupported keyword nested deep inside", () => {
  const out = toAnthropicOutputFormatSchema({
    type: "object",
    properties: {
      list: {
        type: "array",
        items: {
          type: "object",
          properties: { score: { type: "number", maximum: 5 } },
          required: ["score"],
          additionalProperties: false,
        },
      },
    },
    required: ["list"],
    additionalProperties: false,
  });
  assert.equal(out, null);
});

test("normalizer refuses non-object input", () => {
  assert.equal(toAnthropicOutputFormatSchema(null), null);
  assert.equal(toAnthropicOutputFormatSchema("nope"), null);
  assert.equal(toAnthropicOutputFormatSchema([{ type: "object" }]), null);
});

// --------------------------------------------------------------- translator

test("a compatible json_schema goes NATIVE and stops being injected", () => {
  const result = requestWith(jsonSchemaFormat(SIMPLE));

  const format = (result.output_config as Record<string, unknown> | undefined)?.format as
    Record<string, unknown> | undefined;
  assert.ok(format, "output_config.format must be set");
  assert.equal(format.type, "json_schema");
  assert.deepEqual(format.schema, SIMPLE);

  assert.doesNotMatch(
    systemText(result),
    /strictly follows this JSON schema/i,
    "the schema must not be duplicated into the prompt when it is enforced natively"
  );
});

test("OpenAI-only wrapper fields are not forwarded to Anthropic", () => {
  const result = requestWith(jsonSchemaFormat(SIMPLE));
  const format = (result.output_config as Record<string, unknown>).format as Record<
    string,
    unknown
  >;
  assert.equal(format.name, undefined, "`name` is an OpenAI field");
  assert.equal(format.strict, undefined, "`strict` is an OpenAI field");
  assert.equal(
    (result as Record<string, unknown>).response_format,
    undefined,
    "response_format must never reach Anthropic"
  );
});

test("an incompatible schema falls back to injection instead of 400ing", () => {
  const schema = {
    type: "object",
    properties: { score: { type: "integer", minimum: 1, maximum: 5 } },
    required: ["score"],
    additionalProperties: false,
  };
  const result = requestWith(jsonSchemaFormat(schema));

  assert.equal(
    (result.output_config as Record<string, unknown> | undefined)?.format,
    undefined,
    "no native format for a schema the upstream refuses"
  );
  const text = systemText(result);
  assert.match(text, /strictly follows this JSON schema/i);
  assert.match(text, /"minimum"/, "the dropped constraint still reaches the model");
});

test("json_object keeps the prompt path — there is no schema to constrain with", () => {
  const result = requestWith({ type: "json_object" });
  assert.equal((result.output_config as Record<string, unknown> | undefined)?.format, undefined);
  assert.match(systemText(result), /respond with valid JSON/i);
});

test("no response_format leaves output_config.format unset", () => {
  const result = openaiToClaudeRequest(
    "claude-sonnet-5",
    { messages: [{ role: "user", content: "oi" }], max_tokens: 100 },
    false
  );
  assert.equal((result.output_config as Record<string, unknown> | undefined)?.format, undefined);
});

test("format merges with reasoning effort instead of clobbering it", () => {
  const result = requestWith(jsonSchemaFormat(SIMPLE), {
    reasoning_effort: "high",
  });
  const oc = result.output_config as Record<string, unknown>;
  assert.ok(oc.format, "schema survives");
  assert.equal(oc.effort, "high", "effort survives");
});
