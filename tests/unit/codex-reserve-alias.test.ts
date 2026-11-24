import test from "node:test";
import assert from "node:assert/strict";

// Os imports com await ficam todos antes do primeiro test(): o node:test começa a rodar assim que
// o primeiro teste é registrado e ignora os que chegam depois de um await.
const { createChatPipelineHarness } = await import("../integration/_chatPipelineHarness.ts");
const h = await createChatPipelineHarness("codex-reserve-alias");
const providersDb = await import("../../src/lib/db/providers.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
const { resolveCodexReserveAlias } =
  await import("../../src/sse/handlers/chat/codexReserveAlias.ts");
const { resolveFamilyTargetModel, pickNewestFamilyMember } =
  await import("../../src/lib/usage/modelFamilyGlob.ts");

test("gpt-reserve vira o Luna mais novo do registro, mantendo o prefixo do cliente", () => {
  const newest = resolveFamilyTargetModel("codex", "gpt-*-luna");
  assert.ok(newest, "o registro do Codex precisa ter um Luna");
  assert.match(newest, /^gpt-[\d.]+-luna$/, "sem sufixo de esforço (-high, -low…)");
  assert.equal(resolveCodexReserveAlias("codex/gpt-reserve"), `codex/${newest}`);
  assert.equal(resolveCodexReserveAlias("cx/gpt-reserve"), `cx/${newest}`);
  assert.equal(resolveCodexReserveAlias("gpt-reserve"), `codex/${newest}`);
  assert.equal(resolveCodexReserveAlias("  Codex/GPT-Reserve "), `Codex/${newest}`);
});

test("hoje o Luna mais novo é o gpt-6-luna e o sobrenome da versão vence (6 > 5.6)", () => {
  assert.equal(resolveCodexReserveAlias("codex/gpt-reserve"), "codex/gpt-6-luna");
  assert.equal(
    pickNewestFamilyMember(
      ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-high", "gpt-6.1-luna"],
      "gpt-*-luna"
    ),
    "gpt-6.1-luna"
  );
});

test("o que não é o gpt-reserve do Codex passa intacto", () => {
  for (const model of [
    "gpt-6-luna",
    "codex/gpt-6-luna",
    "claude/gpt-reserve",
    "openai/gpt-reserve",
    "gpt-reserve-2",
    "codex/gpt-reserve-high",
    "reserve",
    "",
    "   ",
  ]) {
    assert.equal(resolveCodexReserveAlias(model), null, model);
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(resolveCodexReserveAlias(value), null);
  }
});

// ── Pelo handleChat: o que o upstream recebe e o que a conta registra ─────────────────────────
let upstreamModels: string[] = [];

function completedSse(model: string): Response {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_fixture",
      object: "response",
      status: "completed",
      model,
      output: [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
  const delta = { type: "response.output_text.delta", item_id: "msg_fixture", delta: "ok" };
  return new Response(
    `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

test.beforeEach(async () => {
  await h.resetStorage();
  h.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await h.settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  upstreamModels = [];
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-reserve-fixture",
    accessToken: "fixture-token",
    refreshToken: "fixture-token-refresh",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    isActive: true,
    testStatus: "active",
    priority: 1,
    providerSpecificData: {},
  });
  assert.ok(connection && typeof connection.id === "string");
  globalThis.fetch = async (input, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/chatgpt\.com\/backend-api\/codex\/responses/.test(url)) {
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    }
    const sent = JSON.parse(String(init.body ?? "{}")) as { model?: string };
    upstreamModels.push(String(sent.model));
    return completedSse(String(sent.model));
  };
});

test.afterEach(async () => {
  flushProxyLogsSync();
  h.BaseExecutor.RETRY_CONFIG.delayMs = h.originalRetryDelayMs;
  await h.resetStorage();
});

test.after(() => {
  flushProxyLogsSync();
  return h.cleanup();
});

async function send(model: string) {
  const response = await h.handleChat(
    h.buildRequest({
      body: {
        model,
        stream: true,
        messages: [{ role: "user", content: `Reply ok ${crypto.randomUUID()}` }],
      },
    })
  );
  await response.text();
  return response.status;
}

test("handleChat: o pedido em codex/gpt-reserve chega ao upstream como o Luna mais novo", async () => {
  assert.equal(await send("codex/gpt-reserve"), 200);
  assert.deepEqual(upstreamModels, ["gpt-6-luna"]);
});

test("handleChat: um modelo normal do Codex segue sem mudança", async () => {
  assert.equal(await send("codex/gpt-5.6-luna"), 200);
  assert.deepEqual(upstreamModels, ["gpt-5.6-luna"]);
});
