import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-long-context-gate");
const { getProviderConnectionById } = await import("../../src/lib/db/providers.ts");
const {
  BaseExecutor,
  buildClaudeResponse,
  buildRequest,
  handleChat,
  resetStorage,
  seedApiKey,
  seedConnection,
  settingsDb,
} = harness;

const GATE_MESSAGE = "Usage credits are required for long context requests.";
const originalRetryConfig = {
  maxAttempts: BaseExecutor.RETRY_CONFIG.maxAttempts,
  delayMs: BaseExecutor.RETRY_CONFIG.delayMs,
};

function anthropicError(status: number, message: string) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function anthropicSseResponse(text: string, model: string) {
  const frames = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_s",
          type: "message",
          role: "assistant",
          model,
          content: [],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const payload = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function seedClaudeConnection(apiKey: string): Promise<string> {
  const row = await seedConnection("claude", { apiKey });
  return String((row as { id?: unknown }).id);
}

async function cooldownOf(connectionId: string): Promise<unknown> {
  const row = await getProviderConnectionById(connectionId);
  return row ? (row as { rateLimitedUntil?: unknown }).rateLimitedUntil : undefined;
}

function requestedModelOf(init: RequestInit | undefined): string {
  return JSON.parse(String(init?.body || "{}")).model;
}

function chatBody(model: string) {
  return {
    model,
    stream: false,
    max_tokens: 64,
    messages: [{ role: "user", content: "long context please" }],
  };
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.maxAttempts = originalRetryConfig.maxAttempts;
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 1, maxRetryIntervalSec: 3 });
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = originalRetryConfig.delayMs;
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("a long-context gate on Sonnet 4.6 is re-served by the newest Sonnet, without cooling the account", async () => {
  const connectionId = await seedClaudeConnection("sk-ant-gate-ok");

  const seen: string[] = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    const model = requestedModelOf(init);
    seen.push(model);
    if (model === "claude-sonnet-4-6") return anthropicError(429, GATE_MESSAGE);
    return buildClaudeResponse("served by the substitute", model);
  };

  const response = await handleChat(buildRequest({ body: chatBody("claude/claude-sonnet-4-6") }));
  const body = (await response.json()) as { choices: { message: { content: string } }[] };

  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "served by the substitute");
  assert.deepEqual(seen, ["claude-sonnet-4-6", "claude-sonnet-5-5"]);

  // The gate is a verdict on the request, not on the account: no cooldown was armed.
  const cooldown = await cooldownOf(connectionId);
  assert.ok(!cooldown, `account was cooled down: ${cooldown}`);
});

test("a STREAMING request refused by the gate is re-served as a stream by the substitute", async () => {
  const connectionId = await seedClaudeConnection("sk-ant-gate-stream");

  const seen: string[] = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    const model = requestedModelOf(init);
    seen.push(model);
    if (model === "claude-sonnet-4-6") return anthropicError(429, GATE_MESSAGE);
    return anthropicSseResponse("streamed by the substitute", model);
  };

  const response = await handleChat(
    buildRequest({ body: { ...chatBody("claude/claude-sonnet-4-6"), stream: true } })
  );
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(text, /streamed by the substitute/);
  assert.deepEqual(seen, ["claude-sonnet-4-6", "claude-sonnet-5-5"]);
  const cooldown = await cooldownOf(connectionId);
  assert.ok(!cooldown, `account was cooled down: ${cooldown}`);
});

test("the gate error is returned untouched, once, when the key may not use the substitute", async () => {
  const connectionId = await seedClaudeConnection("sk-ant-gate-denied");
  const key = await seedApiKey({
    name: "gate-restricted",
    allowedModels: ["claude/claude-sonnet-4-6"],
  });

  const seen: string[] = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    seen.push(requestedModelOf(init));
    return anthropicError(429, GATE_MESSAGE);
  };

  const response = await handleChat(
    buildRequest({ authKey: key.key, body: chatBody("claude/claude-sonnet-4-6") })
  );

  assert.equal(response.status, 429);
  // One upstream call: no substitute (not allowed) and no cooldown-retry resend of the refused body.
  assert.deepEqual(seen, ["claude-sonnet-4-6"]);
  const cooldown = await cooldownOf(connectionId);
  assert.ok(!cooldown, `account was cooled down: ${cooldown}`);
});

test("the newest family member has nothing to upgrade to: the error returns, no retry loop", async () => {
  const connectionId = await seedClaudeConnection("sk-ant-gate-newest");

  const seen: string[] = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    seen.push(requestedModelOf(init));
    return anthropicError(429, GATE_MESSAGE);
  };

  const response = await handleChat(buildRequest({ body: chatBody("claude/claude-sonnet-5-5") }));

  assert.equal(response.status, 429);
  assert.deepEqual(seen, ["claude-sonnet-5-5"]);
  const cooldown = await cooldownOf(connectionId);
  assert.ok(!cooldown, `account was cooled down: ${cooldown}`);
});

test("a genuine 429 rate limit is NOT substituted and still cools the account down", async () => {
  const connectionId = await seedClaudeConnection("sk-ant-real-429");
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });

  const seen: string[] = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    seen.push(requestedModelOf(init));
    return anthropicError(429, "Number of request tokens has exceeded your per-minute rate limit");
  };

  const response = await handleChat(buildRequest({ body: chatBody("claude/claude-sonnet-4-6") }));

  assert.equal(response.status, 429);
  // The guard must not mask real throttling: no model swap, and the cooldown is armed.
  assert.ok(
    seen.every((model) => model === "claude-sonnet-4-6"),
    `swapped: ${seen.join(",")}`
  );
  assert.ok(await cooldownOf(connectionId), "a real rate limit must still cool the account down");
});
