// The generation body must read like the official agy CLI's (captured 2026-10-25 from
// agy 1.4.7 with the generation intercepted locally): request id shape, labels,
// key order, per-conversation sessionId, and none of OmniRoute's own defaults
// (toolConfig VALIDATED, topK 40, topP 1, a `system` role).
import test from "node:test";
import assert from "node:assert/strict";

import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import {
  recordAntigravityModelEnums,
  resetAntigravityModelEnumsForTests,
} from "../../open-sse/config/antigravityModelEnums.ts";
import {
  applyAntigravityCliEnvelopeIdentity,
  isDefaultAntigravityToolConfig,
} from "../../open-sse/services/antigravityCliEnvelope.ts";
import { seedAntigravityVersionCache } from "../../open-sse/services/antigravityVersion.ts";

type Envelope = Record<string, unknown> & {
  requestId: string;
  request: Record<string, unknown> & {
    labels?: Record<string, string>;
    sessionId?: string;
    generationConfig?: Record<string, unknown>;
    toolConfig?: unknown;
    systemInstruction?: { role?: string };
  };
};

// Key order of the official CLI's `agent` request (generation-2 of the capture).
const CLI_TOP_LEVEL = ["project", "requestId", "request", "model", "userAgent", "requestType"];
const CLI_REQUEST_KEYS = [
  "contents",
  "systemInstruction",
  "tools",
  "labels",
  "generationConfig",
  "sessionId",
];
const CLI_LABEL_KEYS = [
  "cascade_id",
  "last_step_index",
  "model_enum",
  "request_id",
  "root_cascade_id",
  "trajectory_id",
  "used_claude",
  "used_claude_conservative",
  "used_non_gemini_model",
];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

seedAntigravityVersionCache("2026.10.25-test");

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

async function buildEnvelope(
  model: string,
  messages: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  providerSpecificData: Record<string, unknown> = {}
): Promise<Envelope> {
  const credentials = {
    accessToken: "token",
    projectId: "aicode-consumers",
    connectionId: "conn-envelope",
    email: "user@example.test",
    providerSpecificData,
  };
  const body = { model, stream: true, messages, tools: [READ_FILE_TOOL], ...extra };
  const translated = translateRequest(
    FORMATS.OPENAI,
    FORMATS.ANTIGRAVITY,
    model,
    body,
    true,
    credentials,
    "agy"
  ) as Record<string, unknown>;
  return (await new AntigravityExecutor().transformRequest(
    model,
    structuredClone(translated),
    true,
    credentials as never
  )) as Envelope;
}

const OPENING = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Responda exatamente: pong" },
];

test("an agent request has the CLI's shape: key order, request id, labels, no OmniRoute defaults", async () => {
  const env = await buildEnvelope("gemini-3.8-flash-high", OPENING);

  assert.deepEqual(
    Object.keys(env).filter((key) => !key.startsWith("_")),
    CLI_TOP_LEVEL
  );
  assert.match(env.requestId, new RegExp(`^agent/${UUID}/\\d{13}/${UUID}/1$`));
  assert.deepEqual(Object.keys(env.request), CLI_REQUEST_KEYS);
  assert.equal(env.request.toolConfig, undefined, "the CLI sends no toolConfig");
  assert.equal(env.request.systemInstruction?.role, "user");
  assert.equal(env.request.generationConfig?.topK, undefined);
  assert.equal(env.request.generationConfig?.topP, undefined);
  assert.deepEqual(Object.keys(env.request.generationConfig ?? {}), [
    "maxOutputTokens",
    "thinkingConfig",
  ]);

  const labels = env.request.labels ?? {};
  assert.deepEqual(Object.keys(labels), CLI_LABEL_KEYS);
  assert.equal(labels.model_enum, "MODEL_PLACEHOLDER_M318");
  assert.equal(labels.last_step_index, "0");
  assert.equal(labels.root_cascade_id, labels.cascade_id);
  assert.equal(labels.request_id, `${labels.trajectory_id}-0`);
  assert.deepEqual(
    [labels.used_claude, labels.used_claude_conservative, labels.used_non_gemini_model],
    ["false", "false", "false"]
  );
  // requestId carries the same cascade and trajectory as the labels.
  const [, cascade, , trajectory] = env.requestId.split("/");
  assert.equal(cascade, labels.cascade_id);
  assert.equal(trajectory, labels.trajectory_id);
  assert.match(String(env.request.sessionId), /^-?\d{1,19}$/);
});

test("one conversation keeps its cascade and sessionId; a new one gets new ones", async () => {
  const first = await buildEnvelope("gemini-3.8-flash-high", OPENING);
  const nextTurn = await buildEnvelope("gemini-3.8-flash-high", [
    ...OPENING,
    { role: "assistant", content: "pong" },
    { role: "user", content: "e agora?" },
  ]);
  const other = await buildEnvelope("gemini-3.8-flash-high", [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "outra conversa" },
  ]);

  assert.equal(nextTurn.request.sessionId, first.request.sessionId);
  assert.equal(nextTurn.request.labels?.cascade_id, first.request.labels?.cascade_id);
  assert.notEqual(nextTurn.request.labels?.trajectory_id, first.request.labels?.trajectory_id);
  assert.equal(nextTurn.request.labels?.last_step_index, "1");
  assert.notEqual(other.request.sessionId, first.request.sessionId);
  assert.notEqual(other.request.labels?.cascade_id, first.request.labels?.cascade_id);
});

test("an explicit tool_choice survives; only the default VALIDATED is dropped", async () => {
  const forced = await buildEnvelope("gemini-3.8-flash-high", OPENING, { tool_choice: "required" });
  assert.deepEqual(forced.request.toolConfig, { functionCallingConfig: { mode: "ANY" } });

  assert.equal(
    isDefaultAntigravityToolConfig({ functionCallingConfig: { mode: "VALIDATED" } }),
    true
  );
  assert.equal(isDefaultAntigravityToolConfig({ functionCallingConfig: { mode: "AUTO" } }), true);
  assert.equal(isDefaultAntigravityToolConfig({ functionCallingConfig: { mode: "NONE" } }), false);
  assert.equal(
    isDefaultAntigravityToolConfig({
      functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["read_file"] },
    }),
    false
  );
});

test("the legacy ide profile keeps its previous envelope", async () => {
  const env = await buildEnvelope("gemini-3.8-flash-high", OPENING, {}, { clientProfile: "ide" });
  assert.match(env.requestId, /^agent\/\d{13}\/[0-9a-f]{8}$/);
  assert.equal(env.request.labels, undefined);
  assert.deepEqual(env.request.toolConfig, { functionCallingConfig: { mode: "VALIDATED" } });
});

test("model_enum follows the live catalog and is left out for an unknown id", () => {
  resetAntigravityModelEnumsForTests();
  const base = {
    project: "p",
    requestId: "x",
    request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    model: "gemini-3.8-flash-high",
  };
  const opts = { accountKey: "a", trajectoryId: "11111111-1111-4111-8111-111111111111", nowMs: 1 };
  recordAntigravityModelEnums({ "gemini-3.8-flash-high": { model: "MODEL_PLACEHOLDER_M999" } });
  const live = applyAntigravityCliEnvelopeIdentity(base, opts) as Envelope;
  assert.equal(live.request.labels?.model_enum, "MODEL_PLACEHOLDER_M999");

  const unknown = applyAntigravityCliEnvelopeIdentity(
    { ...base, model: "gemini-9-new" },
    opts
  ) as Envelope;
  assert.equal(unknown.request.labels?.model_enum, undefined);
  assert.equal(unknown.request.labels?.used_non_gemini_model, "false");
  resetAntigravityModelEnumsForTests();

  const claude = applyAntigravityCliEnvelopeIdentity(
    { ...base, model: "claude-sonnet-5-5-medium" },
    opts
  ) as Envelope;
  assert.equal(claude.request.labels?.model_enum, "MODEL_PLACEHOLDER_M404");
  assert.deepEqual(
    [
      claude.request.labels?.used_claude,
      claude.request.labels?.used_claude_conservative,
      claude.request.labels?.used_non_gemini_model,
    ],
    ["true", "true", "true"]
  );
});
