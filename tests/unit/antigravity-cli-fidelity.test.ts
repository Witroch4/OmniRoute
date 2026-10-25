// Fidelity diff against the official agy CLI 1.4.7 (tests/fixtures/antigravity/, captured
// 2026-10-25 with the generation intercepted locally). Builds the request OmniRoute sends for
// the SAME tools the CLI declared and compares structure field by field: tool grouping, type
// casing, key order, labels, generationConfig per model, system instruction shape.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { finalizeAntigravityRequestBody } from "../../open-sse/executors/antigravity/executeAttempt.ts";
import { seedAntigravityVersionCache } from "../../open-sse/services/antigravityVersion.ts";
import {
  canonicalizeAntigravityCliSchema,
  formatAntigravityCliLocalTime,
  wrapAntigravityCliUserTurn,
} from "../../open-sse/services/antigravityCliEnvelope.ts";
import {
  getAntigravityCliGeneration,
  hasAntigravityCliGeneration,
} from "../../open-sse/config/antigravityCliCatalog.ts";

type Json = Record<string, unknown>;
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/antigravity/agy-cli-1.4.7-generation.json", import.meta.url),
    "utf8"
  )
) as {
  topLevelKeys: string[];
  requestKeys: string[];
  labelKeys: string[];
  generationConfig: Json;
  systemInstructionRole: string;
  systemInstructionParts: number;
  toolGroups: Array<{ functionDeclarations: Array<Json & { name: string; parameters: Json }> }>;
};

seedAntigravityVersionCache("2026.10.25-test");

/** The CLI's own tool declarations as a lowercase-typed, client-style OpenAI tools list. */
function clientTools() {
  const lower = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(lower);
    if (n && typeof n === "object") {
      return Object.fromEntries(
        Object.entries(n as Json).map(([k, v]) => [
          k,
          k === "type" && typeof v === "string" ? v.toLowerCase() : lower(v),
        ])
      );
    }
    return n;
  };
  return fixture.toolGroups.map((g) => ({
    type: "function",
    function: {
      name: g.functionDeclarations[0].name,
      description: "d",
      parameters: lower(g.functionDeclarations[0].parameters),
    },
  }));
}

async function sentBody(
  model: string,
  extra: Json = {},
  providerSpecificData: Json = {}
): Promise<Json & { request: Json }> {
  const credentials = {
    accessToken: "t",
    projectId: "aicode-consumers",
    connectionId: "c-fid",
    email: "fid@example.test",
    providerSpecificData,
  };
  const body = {
    model,
    stream: true,
    messages: [{ role: "user", content: "Responda exatamente: pong" }],
    tools: clientTools(),
    ...extra,
  };
  const translated = translateRequest(
    FORMATS.OPENAI,
    FORMATS.ANTIGRAVITY,
    model,
    body,
    true,
    credentials,
    "agy"
  ) as Json;
  const envelope = (await new AntigravityExecutor().transformRequest(
    model,
    structuredClone(translated),
    true,
    credentials as never
  )) as Json;
  // What leaves the executor loop: tool cloak (off on the cli profile), schema sanitize.
  const profileIsCli = providerSpecificData.clientProfile !== "ide";
  return finalizeAntigravityRequestBody(
    envelope,
    false,
    { debug() {}, warn() {}, info() {} } as never,
    { cloakTools: !profileIsCli }
  ) as Json & { request: Json };
}

test("top-level and request key order match the CLI's", async () => {
  const body = await sentBody("gemini-3.8-flash-high");
  assert.deepEqual(
    Object.keys(body).filter((k) => !k.startsWith("_")),
    fixture.topLevelKeys
  );
  assert.deepEqual(Object.keys(body.request), fixture.requestKeys);
  assert.deepEqual(Object.keys(body.request.labels as Json), fixture.labelKeys);
});

test("tools: same names, one declaration per group, upper-case types, CLI key order", async () => {
  const body = await sentBody("gemini-3.8-flash-high");
  const groups = body.request.tools as typeof fixture.toolGroups;
  assert.equal(groups.length, fixture.toolGroups.length, "no decoys, no extra groups");
  for (const [i, group] of groups.entries()) {
    assert.equal(group.functionDeclarations.length, 1, "one declaration per group");
    const sent = group.functionDeclarations[0];
    const official = fixture.toolGroups[i].functionDeclarations[0];
    assert.equal(sent.name, official.name, "original name: no _ide suffix");
    assert.deepEqual(Object.keys(sent), Object.keys(official));
    // Compare the schema with descriptions blanked on both sides (the fixture has 'd').
    const blank = (n: unknown): unknown => {
      if (Array.isArray(n)) return n.map(blank);
      if (n && typeof n === "object") {
        return Object.fromEntries(
          Object.entries(n as Json).map(([k, v]) => [k, k === "description" ? "d" : blank(v)])
        );
      }
      return n;
    };
    assert.equal(
      JSON.stringify(blank(sent.parameters)),
      JSON.stringify(official.parameters),
      `${official.name}: schema bytes (type case, key order, property order) match the CLI`
    );
  }
  assert.equal(
    body.request.toolConfig,
    undefined,
    "no toolConfig, no includeServerSideToolInvocations"
  );
});

test("system instruction is one user part, like the CLI's", async () => {
  const body = await sentBody("gemini-3.8-flash-high", {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "oi" },
    ],
  });
  const si = body.request.systemInstruction as { role: string; parts: unknown[] };
  assert.equal(si.role, fixture.systemInstructionRole);
  assert.equal(si.parts.length, fixture.systemInstructionParts);
});

test("generationConfig for a silent client is exactly what the CLI sends, per model", async () => {
  // gemini-3.8-flash-high is the fixture's own model; the rest come from the per-model captures.
  assert.deepEqual(
    (await sentBody("gemini-3.8-flash-high")).request.generationConfig,
    fixture.generationConfig
  );
  for (const model of [
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-low",
    "claude-sonnet-5-5-medium",
    "claude-opus-5-5-high",
    "gpt-oss-120b-medium",
  ]) {
    const cli = getAntigravityCliGeneration(model);
    assert.ok(cli, `${model} has a captured entry`);
    const sent = (await sentBody(model)).request.generationConfig as Json;
    assert.deepEqual(sent, cli, `${model}: cap and thinking as the CLI sends them`);
    assert.equal(hasAntigravityCliGeneration(model, sent), true);
  }
});

test("a client that sets its own cap or reasoning keeps its values", async () => {
  const capped = (await sentBody("gemini-3.8-flash-high", { max_tokens: 4000 })).request
    .generationConfig as Json;
  assert.ok(Number(capped.maxOutputTokens) <= 4000 + 8192, "client cap is not replaced by 65536");
  assert.notEqual(capped.maxOutputTokens, 65536);

  const reasoning = (await sentBody("gemini-3.8-flash-low", { reasoning_effort: "high" })).request
    .generationConfig as Json;
  assert.notDeepEqual(
    (reasoning.thinkingConfig as Json).thinkingBudget,
    1000,
    "an explicit effort wins over the tier default"
  );
});

test("the legacy ide profile keeps the cloak, the old generation defaults and no wrapper", async () => {
  const body = await sentBody("gemini-3.8-flash-high", {}, { clientProfile: "ide" });
  const names = (body.request.tools as typeof fixture.toolGroups).flatMap((g) =>
    g.functionDeclarations.map((d) => d.name)
  );
  assert.ok(
    names.some((n) => n.endsWith("_ide")),
    "client tools are still suffixed on ide"
  );
  assert.ok(names.length > fixture.toolGroups.length, "decoys are still added on ide");
  const text = JSON.stringify(body.request.contents);
  assert.doesNotMatch(text, /USER_REQUEST/);
});

test("the user turn is wrapped like the CLI and tool results are not", () => {
  const now = Date.UTC(2026, 9, 25, 13, 11, 29);
  assert.equal(
    formatAntigravityCliLocalTime(now, "America/Sao_Paulo"),
    "2026-10-25T10:11:29-03:00"
  );
  assert.equal(formatAntigravityCliLocalTime(now, "UTC"), "2026-10-25T13:11:29+00:00");
  assert.equal(formatAntigravityCliLocalTime(now, "Not/AZone"), "2026-10-25T10:11:29-03:00");

  const wrapped = wrapAntigravityCliUserTurn(
    [{ role: "user", parts: [{ text: "Responda exatamente: pong" }] }],
    now,
    "America/Sao_Paulo"
  ) as Array<{ parts: Array<{ text: string }> }>;
  assert.equal(
    wrapped[0].parts[0].text,
    "<USER_REQUEST>\nResponda exatamente: pong\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n" +
      "The current local time is: 2026-10-25T10:11:29-03:00.\n</ADDITIONAL_METADATA>"
  );

  const toolTurn = [
    { role: "model", parts: [{ functionCall: { name: "read_file", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "read_file", response: {} } }] },
  ];
  assert.strictEqual(wrapAntigravityCliUserTurn(toolTurn, now, "UTC"), toolTurn);

  const twoTexts = wrapAntigravityCliUserTurn(
    [
      {
        role: "user",
        parts: [{ text: "a" }, { inlineData: { mimeType: "image/png", data: "x" } }, { text: "b" }],
      },
    ],
    now,
    "UTC"
  ) as Array<{ parts: Array<Json> }>;
  assert.match(String(twoTexts[0].parts[0].text), /^<USER_REQUEST>\na$/);
  assert.match(String(twoTexts[0].parts[2].text), /^b\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>/);
});

test("schema canonicalization is meaning-preserving and does not mutate its input", () => {
  const input = {
    properties: { b: { description: "x", type: "string" }, a: { type: "integer" } },
    required: ["b"],
    type: "object",
  };
  const snapshot = JSON.stringify(input);
  const out = canonicalizeAntigravityCliSchema(input) as Json;
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(
    JSON.stringify(out),
    '{"type":"OBJECT","properties":{"a":{"type":"INTEGER"},"b":{"type":"STRING","description":"x"}},"required":["b"]}'
  );
});
