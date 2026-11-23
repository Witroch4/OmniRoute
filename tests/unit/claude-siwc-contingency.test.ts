import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("claude-siwc-contingency");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const { updateSettingsSchema } = await import("../../src/shared/validation/settingsSchemas.ts");
const budgetRules = await import("../../src/lib/db/apiKeyModelBudgetRules.ts");
const budgetRouting = await import("../../src/lib/usage/modelBudgetRouting.ts");
const costRules = await import("../../src/domain/costRules.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const keyGroups = await import("../../src/lib/db/apiKeyGroups.ts");
const messagesRoute = await import("../../src/app/api/v1/messages/route.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const cooldowns = await import("../../open-sse/services/providerCooldownTracker.ts");
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
const quotaPools = await import("../../src/lib/db/quotaPools.ts");
const quotaGroups = await import("../../src/lib/db/quotaGroups.ts");
const { resolveClaudeSiwcContingency } =
  await import("../../src/sse/handlers/chat/claudeSiwcContingency.ts");
const NODE = "openai-compatible-siwc-test";
const TARGET = "siwc/witdev_siwc/gpt-terra-latest";
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

test.beforeEach(async () => {
  await h.resetStorage();
  costRules.resetCostData();
  accountFallback.clearAllModelLockouts();
  quotaCache.__clearForTests();
  cooldowns.clearCooldownState();
  h.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  calls.length = 0;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body || "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return String(url).includes("/internal/llm/")
      ? h.buildOpenAIResponse("SIWC served", "witdev_siwc/gpt-terra-latest")
      : h.buildClaudeResponse("Claude served", String(body.model));
  };
});
test.after(async () => h.cleanup());

async function setup(enabled = true, mode?: "single" | "segmented") {
  const source = await h.seedConnection("claude");
  await providersDb.createProviderNode({
    id: NODE,
    type: "openai-compatible",
    name: "Witdev SIWC",
    prefix: "siwc",
    baseUrl: "https://api.witdev.com.br/internal/llm/v1",
    chatPath: "/chat/completions",
    modelsPath: "/models",
  });
  const target = await h.seedConnection(NODE, {
    providerSpecificData: { baseUrl: "https://api.witdev.com.br/internal/llm/v1", apiType: "chat" },
  });
  await h.settingsDb.updateSettings({
    claudeSiwcContingency: {
      enabled,
      targetModel: TARGET,
      connectionId: target.id,
      ...(mode ? { mode } : {}),
    },
  });
  return { source, target };
}

async function billedUsage(keyId: string) {
  return (await h.waitFor(() =>
    h.core
      .getDbInstance()
      .prepare(
        "SELECT provider, model, billed_provider, billed_model FROM usage_history WHERE api_key_id = ? AND success = 1"
      )
      .get(keyId)
  )) as { provider: string; model: string; billed_provider: string; billed_model: string } | null;
}

async function spend(keyId: string, model: string) {
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model,
    apiKeyId: keyId,
    tokens: { input: 1_000_000, output: 1_000_000 },
    success: true,
    timestamp: new Date().toISOString(),
  });
}

async function chat(model: string, authKey?: string, extra: Record<string, unknown> = {}) {
  return h.handleChat(
    h.buildRequest({
      url: "http://localhost/v1/messages",
      authKey,
      body: {
        model,
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
        ...extra,
      },
    })
  );
}

test("enabled contingency substitutes authorized Claude with the pinned SIWC connection", async () => {
  const { source, target } = await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"], allowedConnections: [source.id] });
  const response = await chat("cc/claude-opus-4-8", key.key);
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.model, "claude-opus-4-8");
  assert.match(response.headers.get("x-omniroute-contingency") || "", /claude-siwc/);
  assert.equal(response.headers.get("x-omniroute-selected-connection-id"), target.id);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/internal\/llm\//);
  assert.equal(calls[0].body.model, "witdev_siwc/gpt-terra-latest");
  const metadata = await h.apiKeysDb.getApiKeyMetadata(key.key);
  assert.deepEqual(metadata?.allowedModels, ["cc/*"]);
  assert.deepEqual(metadata?.allowedConnections, [source.id]);
  const usage = (await h.waitFor(() =>
    h.core
      .getDbInstance()
      .prepare(
        "SELECT provider, model, billed_provider, billed_model FROM usage_history WHERE api_key_id = ? AND success = 1"
      )
      .get(key.id)
  )) as { provider: string; model: string; billed_provider: string; billed_model: string } | null;
  assert.ok(usage);
  assert.equal(usage.provider, NODE);
  assert.equal(usage.model, "witdev_siwc/gpt-terra-latest");
  assert.equal(usage.billed_provider, "claude");
  assert.equal(usage.billed_model, "claude-opus-4-8");
});

test("disabled contingency preserves native Claude routing", async () => {
  await setup(false);
  const response = await chat("cc/claude-sonnet-5");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-omniroute-contingency"), null);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes("/internal/llm/"));
});

test("legacy bare Haiku keeps the existing off ambiguity and routes to SIWC only when enabled", async () => {
  const { target } = await setup(false);
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
  const before = await chat("claude-haiku-4-5");
  assert.equal(before.status, 400);
  assert.match(await before.text(), /Ambiguous model/);
  assert.equal(calls.length, 0);
  await h.settingsDb.updateSettings({
    claudeSiwcContingency: { enabled: true, targetModel: TARGET, connectionId: target.id },
  });
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  const after = await chat("claude-haiku-4-5", key.key);
  assert.equal(after.status, 200, await after.clone().text());
  assert.equal((await after.json()).model, "claude-haiku-4-5");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/internal/llm/"));
});

test("a stored combo with legacy bare Haiku uses the enabled Claude default and SIWC replacement", async () => {
  const { source } = await setup();
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
  await providersDb.updateProviderConnection(source.id, { isActive: false });
  await h.combosDb.createCombo({
    name: "Legacy Haiku flow",
    models: ["claude-haiku-4-5"],
    strategy: "priority",
    config: { maxRetries: 0 },
  });
  const response = await chat("Legacy Haiku flow");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/internal/llm/"));
});

for (const family of ["opus-4-8", "sonnet-5", "haiku-5-5"]) {
  for (const prefix of ["cc/", ""]) {
    test(`routes ${prefix}claude-${family} through SIWC with source echo`, async () => {
      await setup();
      await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
      const response = await chat(`${prefix}claude-${family}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).model, `claude-${family}`);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes("/internal/llm/"));
    });
  }
}

test("an unrelated connection allowlist cannot acquire Claude or SIWC", async () => {
  await setup();
  const unrelated = await h.seedConnection("codex");
  const key = await h.seedApiKey({ allowedModels: ["cc/*"], allowedConnections: [unrelated.id] });
  const response = await chat("cc/claude-sonnet-5", key.key);
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("the original model allowlist remains required", async () => {
  await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/claude-sonnet-5"] });
  const response = await chat("cc/claude-opus-4-8", key.key);
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("invalid authentication and endpoint restrictions remain enforced", async () => {
  await setup();
  process.env.REQUIRE_API_KEY = "true";
  try {
    const invalid = await messagesRoute.POST(
      h.buildRequest({
        url: "http://localhost/v1/messages",
        authKey: "invalid-key",
        body: {
          model: "cc/claude-sonnet-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hi" }],
        },
      })
    );
    assert.equal(invalid.status, 401);
  } finally {
    process.env.REQUIRE_API_KEY = "false";
  }
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, { allowedEndpoints: ["chat:responses"] });
  const denied = await chat("cc/claude-sonnet-5", key.key);
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);
});

test("the target dollar budget remains enforced", async () => {
  await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  costRules.setBudget(key.id, { dailyLimitUsd: 1 });
  costRules.recordCost(key.id, 2);
  const response = await chat("cc/claude-sonnet-5", key.key);
  assert.equal(response.status, 429, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("the original key normalized USD usage limit remains enforced", async () => {
  await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 0.01,
  });
  await usageHistory.saveRequestUsage({
    provider: NODE,
    model: "witdev_siwc/gpt-terra-latest",
    billedProvider: "claude",
    billedModel: "claude-opus-4-8",
    apiKeyId: key.id,
    tokens: { input: 1_000_000, output: 1_000_000 },
    success: true,
    timestamp: new Date().toISOString(),
  });
  const response = await chat("cc/claude-opus-4-8", key.key);
  assert.equal(response.status, 400, await response.clone().text());
  assert.match(await response.text(), /daily usage quota/);
  assert.equal(calls.length, 0);
});

test("contingency precedes model-budget downgrades and preserves the originally requested model", async () => {
  await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  budgetRules.replaceModelBudgetRules(key.id, [
    {
      enabled: true,
      priority: 0,
      sourceProvider: "claude",
      sourceFamily: "claude-opus-*",
      weeklyLimitUsd: 0.01,
      targetProvider: "openai",
      targetFamily: "gpt-4o-mini",
    },
  ]);
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-opus-4-8",
    apiKeyId: key.id,
    tokens: { input: 1_000_000, output: 1_000_000 },
    success: true,
    timestamp: new Date().toISOString(),
  });
  const response = await chat("cc/claude-opus-4-8", key.key);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).model, "claude-opus-4-8");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "witdev_siwc/gpt-terra-latest");
});

test("the private exact grant rejects model overrides after credential selection", async () => {
  const { source } = await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"], allowedConnections: [source.id] });
  const substitution = await resolveClaudeSiwcContingency({
    provider: "claude",
    model: "claude-sonnet-5",
    modelStr: "cc/claude-sonnet-5",
    body: {},
    apiKey: key.key,
    apiKeyInfo: await h.apiKeysDb.getApiKeyMetadata(key.key),
    isCombo: false,
  });
  assert.ok(substitution.contingency);
  const gate = substitution.contingency.gate;
  assert.equal(await gate([`${NODE}/witdev_siwc/gpt-terra-latest`]), null);
  for (const target of [`${NODE}/another-model`, "claude/claude-sonnet-5", "openai/gpt-4o-mini"]) {
    assert.equal((await gate([target]))?.status, 403);
  }
  assert.equal(calls.length, 0);
});

test("the final pipeline gate rejects a connection default that rewrites the exact SIWC target", async () => {
  const { target } = await setup();
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
  await providersDb.updateProviderConnection(target.id, { defaultModel: "gpt-4o-mini" });
  const previous = process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY;
  process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY = "true";
  try {
    const response = await chat("claude-sonnet-5");
    assert.equal(response.status, 403, await response.clone().text());
    assert.equal(calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY;
    else process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY = previous;
  }
});

test("source and target block patterns win over substitution", async () => {
  await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, { blockedModels: ["cc/claude-sonnet-5"] });
  assert.equal((await chat("cc/claude-sonnet-5", key.key)).status, 400);
  await h.apiKeysDb.updateApiKeyPermissions(key.id, { blockedModels: ["siwc/*"] });
  assert.equal((await chat("cc/claude-sonnet-5", key.key)).status, 403);
  assert.equal(calls.length, 0);
});

test("source group permission is sufficient while an explicit target group denial still wins", async () => {
  await setup();
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  const group = keyGroups.createKeyGroup("Claude users");
  keyGroups.addGroupPermission(group.id, "*", "allow", "claude");
  keyGroups.addGroupPermission(group.id, "*", "allow", "cc");
  keyGroups.addKeyToGroup(key.id, group.id);
  assert.equal((await chat("cc/claude-sonnet-5", key.key)).status, 200);
  keyGroups.addGroupPermission(group.id, "*", "deny", "siwc");
  assert.equal((await chat("cc/claude-sonnet-5", key.key)).status, 403);
  assert.equal(calls.length, 1);
});

for (const target of [false, true]) {
  test(`hidden ${target ? "target" : "source"} is rejected before dispatch`, async () => {
    await setup();
    modelsDb.setModelIsHidden(
      target ? NODE : "claude",
      target ? "witdev_siwc/gpt-terra-latest" : "claude-sonnet-5",
      true
    );
    const response = await chat("cc/claude-sonnet-5");
    assert.equal(response.status, 404, await response.clone().text());
    assert.equal(calls.length, 0);
  });
}

test("source health and quota do not prevent the approved replacement", async () => {
  const { source } = await setup();
  await providersDb.updateProviderConnection(source.id, {
    isActive: false,
    rateLimitedUntil: new Date(Date.now() + 3600_000).toISOString(),
  });
  const key = await h.seedApiKey({ allowedModels: ["cc/*"], allowedConnections: [source.id] });
  const response = await chat("cc/claude-sonnet-5", key.key);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/internal/llm/"));
});

test("combo availability defers exhausted Claude source selection to the SIWC substitution", async () => {
  const { source } = await setup();
  await providersDb.updateProviderConnection(source.id, {
    isActive: false,
    rateLimitedUntil: new Date(Date.now() + 3600_000).toISOString(),
  });
  await h.combosDb.createCombo({
    name: "Claude tools flow",
    models: ["cc/claude-sonnet-5"],
    strategy: "priority",
  });
  const key = await h.seedApiKey({
    allowedCombos: ["Claude tools flow"],
    allowedModels: ["cc/*"],
    allowedConnections: [source.id],
  });
  const response = await chat("Claude tools flow", key.key);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-omniroute-contingency"), "claude-siwc");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/internal/llm/"));
});

for (const strategy of ["priority", "weighted", "round-robin"]) {
  test(`${strategy} pinned combo preserves exhausted Claude flow through SIWC and off restores all source gates`, async () => {
    const { source, target } = await setup();
    await providersDb.updateProviderConnection(source.id, {
      isActive: false,
      rateLimitedUntil: new Date(Date.now() + 3600_000).toISOString(),
    });
    quotaCache.markAccountExhaustedFrom429(source.id, "claude");
    accountFallback.lockModel("claude", source.id, "claude-sonnet-5", "model_capacity", 3600_000);
    const breaker = getCircuitBreaker("claude", { failureThreshold: 1 });
    breaker._onFailure();
    assert.equal(breaker.getStatus().state, "OPEN");
    const comboName = `Pinned Claude ${strategy}`;
    await h.combosDb.createCombo({
      name: comboName,
      models: [{ kind: "model", model: "cc/claude-sonnet-5", connectionId: source.id }],
      strategy,
      config: { maxRetries: 0, retryDelayMs: 0 },
    });
    const key = await h.seedApiKey({
      allowedCombos: [comboName],
      allowedModels: ["cc/*"],
      allowedConnections: [source.id],
    });
    const response = await chat(comboName, key.key);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/internal/llm/"));
    assert.equal(breaker.getStatus().state, "OPEN", "SIWC success must not reset source breaker");
    assert.equal(accountFallback.isModelLocked("claude", source.id, "claude-sonnet-5"), true);
    await h.settingsDb.updateSettings({
      claudeSiwcContingency: { enabled: false, targetModel: TARGET, connectionId: target.id },
    });
    const disabled = await chat(comboName, key.key);
    assert.ok([429, 503].includes(disabled.status), await disabled.clone().text());
    assert.equal(calls.length, 1, "off restores source health gates without reaching any upstream");
  });
}

test("SIWC failure in a combo cannot cool or trip the original Claude provider", async () => {
  const { source } = await setup();
  const breaker = getCircuitBreaker("claude", { failureThreshold: 1 });
  await h.combosDb.createCombo({
    name: "SIWC failing flow",
    models: [{ kind: "model", model: "cc/claude-sonnet-5", connectionId: source.id }],
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body || "{}")) });
    return new Response(JSON.stringify({ error: { message: "SIWC unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };
  const response = await chat("SIWC failing flow");
  assert.equal(response.status, 503, await response.clone().text());
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.url.includes("/internal/llm/")));
  assert.equal(breaker.getStatus().state, "CLOSED");
  assert.equal(breaker.getStatus().failureCount, 0);
  assert.equal(accountFallback.isModelLocked("claude", source.id, "claude-sonnet-5"), false);
});

test("combo deferral never grants a source connection excluded by the API key", async () => {
  const { source } = await setup();
  const unrelated = await h.seedConnection("codex");
  await h.combosDb.createCombo({
    name: "Restricted Claude flow",
    models: [{ kind: "model", model: "cc/claude-sonnet-5", connectionId: source.id }],
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
  });
  const key = await h.seedApiKey({
    allowedCombos: ["Restricted Claude flow"],
    allowedModels: ["cc/*"],
    allowedConnections: [unrelated.id],
  });
  const response = await chat("Restricted Claude flow", key.key);
  assert.ok(response.status >= 400, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("source authorization preserves an empty pin intersection before quota expansion", async () => {
  const { source } = await setup();
  const forbidden = await h.seedConnection("claude", { name: "Claude B" });
  assert.notEqual(forbidden.id, source.id);
  const group = quotaGroups.createGroup("Source scope");
  const pool = quotaPools.createPool({
    connectionId: source.id,
    name: "Claude A",
    groupId: group.id,
  });
  const key = await h.seedApiKey({ allowedModels: ["cc/*"], allowedConnections: [source.id] });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, { allowedQuotas: [pool.id] });
  const base = {
    provider: "claude",
    model: "claude-sonnet-5",
    modelStr: "cc/claude-sonnet-5",
    body: {},
    apiKey: key.key,
    apiKeyInfo: await h.apiKeysDb.getApiKeyMetadata(key.key),
    isCombo: true,
  };
  const denied = await resolveClaudeSiwcContingency({ ...base, forcedConnectionId: forbidden.id });
  assert.equal(denied.rejection?.status, 403);
  assert.equal(denied.contingency, undefined);
  const mismatchedPin = await resolveClaudeSiwcContingency({
    ...base,
    forcedConnectionId: forbidden.id,
    allowedConnectionIds: [source.id],
  });
  assert.equal(mismatchedPin.rejection?.status, 403);
  const valid = await resolveClaudeSiwcContingency({ ...base, forcedConnectionId: source.id });
  assert.equal(valid.rejection, undefined);
  assert.ok(valid.contingency);
  assert.equal(calls.length, 0);
});

for (const strategy of [
  "priority",
  "weighted",
  "round-robin",
  "headroom",
  "reset-aware",
  "reset-window",
  "quota-weighted",
]) {
  test(`${strategy} keeps the logical Claude target through connection expansion and quota ranking`, async () => {
    const { source } = await setup();
    const fallback = await h.seedConnection("openai");
    await providersDb.updateProviderConnection(source.id, {
      isActive: false,
      rateLimitedUntil: new Date(Date.now() + 3600_000).toISOString(),
    });
    quotaCache.markAccountExhaustedFrom429(source.id, "claude");
    const comboName = `Expanded Claude ${strategy}`;
    await h.combosDb.createCombo({
      name: comboName,
      models:
        strategy === "weighted"
          ? ["cc/claude-sonnet-5"]
          : ["cc/claude-sonnet-5", "openai/gpt-4o-mini"],
      strategy,
      config: { connectionAwareExpansion: true, maxRetries: 0, retryDelayMs: 0 },
    });
    const key = await h.seedApiKey({
      allowedCombos: [comboName],
      allowedModels: ["cc/*"],
      allowedConnections: [source.id, fallback.id],
    });
    const response = await chat(comboName, key.key);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].url.includes("/internal/llm/"),
      "source quota cannot choose the other provider before its approved replacement"
    );
  });
}

test("an explicitly permitted combo cannot override an original Claude deny pattern", async () => {
  const { source } = await setup();
  await h.combosDb.createCombo({
    name: "Blocked Claude flow",
    models: ["cc/claude-sonnet-5"],
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
  });
  const key = await h.seedApiKey({
    allowedCombos: ["Blocked Claude flow"],
    allowedModels: ["cc/*"],
    allowedConnections: [source.id],
  });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, { blockedModels: ["cc/claude-sonnet-5"] });
  const response = await chat("Blocked Claude flow", key.key);
  assert.ok(response.status >= 400, await response.clone().text());
  assert.equal(calls.length, 0);
  await h.apiKeysDb.updateApiKeyPermissions(key.id, { blockedModels: [] });
  const group = keyGroups.createKeyGroup("Blocked Claude source");
  keyGroups.addGroupPermission(group.id, "*", "allow");
  keyGroups.addGroupPermission(group.id, "*", "deny", "claude");
  keyGroups.addKeyToGroup(key.id, group.id);
  const groupDenied = await chat("Blocked Claude flow", key.key);
  assert.ok(groupDenied.status >= 400, await groupDenied.clone().text());
  assert.equal(calls.length, 0);
});

test("missing configuration fails closed with no Anthropic fallback", async () => {
  await setup();
  await h.settingsDb.updateSettings({
    claudeSiwcContingency: { enabled: true, targetModel: "", connectionId: "" },
  });
  const response = await chat("cc/claude-opus-4-8");
  assert.equal(response.status, 503);
  assert.match(await response.text(), /contingency is enabled.*unavailable/);
  assert.equal(calls.length, 0);
});

test("unavailable target fails closed and never switches connections", async () => {
  const { target } = await setup();
  const sibling = await h.seedConnection(NODE, {
    name: "Witdev SIWC sibling",
    providerSpecificData: { baseUrl: "https://api.witdev.com.br/internal/llm/v1", apiType: "chat" },
  });
  assert.notEqual(sibling.id, target.id);
  await providersDb.updateProviderConnection(target.id, { isActive: false });
  const response = await chat("cc/claude-sonnet-5");
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("a target provider breaker is enforced despite the internal connection pin", async () => {
  await setup();
  const breaker = getCircuitBreaker(NODE, { failureThreshold: 1 });
  breaker._onFailure();
  const response = await chat("cc/claude-sonnet-5");
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("an OmniRoute URL cannot be configured as the target", async () => {
  const { target } = await setup();
  await providersDb.updateProviderConnection(target.id, {
    providerSpecificData: { baseUrl: "http://localhost:20128/v1", apiType: "chat" },
  });
  const response = await chat("cc/claude-sonnet-5");
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

test("unrelated providers and non-family Claude models retain their route", async () => {
  await setup();
  await h.seedConnection("openai");
  await h.seedConnection("anthropic");
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body || "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return body.model === "gpt-4o-mini"
      ? h.buildOpenAIResponse()
      : h.buildClaudeResponse("Native", String(body.model));
  };
  for (const model of ["openai/gpt-4o-mini", "anthropic/claude-sonnet-5", "cc/claude-fable-5"]) {
    const response = await chat(model);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-omniroute-contingency"), null);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => !call.url.includes("/internal/llm/")));
});

for (const stream of [false, true]) {
  test(`${stream ? "SSE" : "JSON"} Claude tools and call ids survive request, response and tool result`, async () => {
    await setup();
    const tool = {
      name: "Bash",
      description: "Run a command",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    };
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(String(options?.body || "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      if (calls.length > 1) return h.buildOpenAIResponse("Done");
      if (!stream)
        return h.buildOpenAIToolCallResponse({
          toolName: "Bash",
          toolCallId: "call_bash",
          argumentsObject: { command: "pwd" },
        });
      const chunks = [
        {
          id: "chatcmpl-tool",
          model: "witdev_siwc/gpt-terra-latest",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_bash",
                    type: "function",
                    function: { name: "Bash", arguments: '{"command":"pwd"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-tool",
          model: "witdev_siwc/gpt-terra-latest",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
        },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    const response = await chat("cc/claude-sonnet-5", undefined, { stream, tools: [tool] });
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"name":"Bash"/);
    assert.match(text, /"id":"call_bash"/);
    assert.match(text, /claude-sonnet-5/);
    const dispatchedTools = calls[0].body.tools as Array<{ function: { name: string } }>;
    assert.equal(dispatchedTools[0].function.name, "Bash");
    const followup = await chat("cc/claude-sonnet-5", undefined, {
      tools: [tool],
      messages: [
        { role: "user", content: "Run pwd" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_bash", name: "Bash", input: { command: "pwd" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_bash", content: "/tmp" }],
        },
      ],
    });
    assert.equal(followup.status, 200, await followup.clone().text());
    const messages = calls[1].body.messages as Array<{
      role: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; function: { name: string } }>;
    }>;
    assert.equal(messages.find((message) => message.role === "tool")?.tool_call_id, "call_bash");
    assert.equal(
      messages.find((message) => message.tool_calls)?.tool_calls?.[0].function.name,
      "Bash"
    );
    assert.ok(calls.every((call) => call.url.includes("/internal/llm/")));
  });
}

test("strict settings schema accepts off defaults and configured target, rejecting credentials and incomplete enabled config", () => {
  assert.equal(
    updateSettingsSchema.safeParse({
      claudeSiwcContingency: { enabled: false, targetModel: "", connectionId: "" },
    }).success,
    true
  );
  assert.equal(
    updateSettingsSchema.safeParse({
      claudeSiwcContingency: { enabled: true, targetModel: TARGET, connectionId: "connection" },
    }).success,
    true
  );
  for (const value of [
    { enabled: true, targetModel: "", connectionId: "" },
    { enabled: true, targetModel: "claude/claude-sonnet-5", connectionId: "connection" },
    { enabled: false, targetModel: "", connectionId: "", apiKey: "secret" },
  ])
    assert.equal(updateSettingsSchema.safeParse({ claudeSiwcContingency: value }).success, false);
});

// ---------------------------------------------------------------- segmented mode
for (const [requested, upstream] of [
  ["cc/claude-fable-5", "witdev_siwc/gpt-sol-latest"],
  ["cc/claude-opus-4-8", "witdev_siwc/gpt-sol-latest"],
  ["cc/claude-sonnet-5", "witdev_siwc/gpt-terra-latest"],
  ["cc/claude-haiku-4-5-20251001", "witdev_siwc/gpt-luna-latest"],
] as const) {
  test(`segmented contingency sends ${requested} to ${upstream}`, async () => {
    const { target } = await setup(true, "segmented");
    const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
    const response = await chat(requested, key.key);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).model, requested.slice(3));
    assert.match(response.headers.get("x-omniroute-contingency") || "", /claude-siwc/);
    assert.equal(response.headers.get("x-omniroute-selected-connection-id"), target.id);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/internal\/llm\//);
    assert.equal(calls[0].body.model, upstream);
    const usage = await billedUsage(key.id);
    assert.ok(usage);
    assert.equal(usage.model, upstream);
    assert.equal(usage.billed_provider, "claude");
    assert.equal(usage.billed_model, requested.slice(3));
  });
}

test("segmented contingency runs family fallback first and substitutes the FINAL model", async () => {
  await setup(true, "segmented");
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  budgetRules.replaceModelBudgetRules(key.id, [
    {
      enabled: true,
      priority: 0,
      sourceProvider: "claude",
      sourceFamily: "claude-fable-*",
      weeklyLimitUsd: 0.01,
      targetProvider: "claude",
      targetFamily: "claude-opus-*",
    },
    {
      enabled: true,
      priority: 0,
      sourceProvider: "claude",
      sourceFamily: "claude-opus-*",
      weeklyLimitUsd: 0.01,
      targetProvider: "claude",
      targetFamily: "claude-sonnet-*",
    },
  ]);
  // Fable exhausted only: Fable → Opus → (Opus still has budget) → Sol.
  await spend(key.id, "claude-fable-5");
  const toOpus = await chat("cc/claude-fable-5", key.key);
  assert.equal(toOpus.status, 200, await toOpus.clone().text());
  assert.equal((await toOpus.json()).model, "claude-fable-5");
  assert.equal(calls.at(-1)?.body.model, "witdev_siwc/gpt-sol-latest");
  // Opus exhausted too: Fable → Opus → Sonnet → Terra. Billing keeps the client's ask.
  await spend(key.id, "claude-opus-4-8");
  budgetRouting.clearModelBudgetRoutingCacheForTests(); // the ladder caches each rule for 60 s
  const toSonnet = await chat("cc/claude-fable-5", key.key);
  assert.equal(toSonnet.status, 200, await toSonnet.clone().text());
  assert.equal(calls.at(-1)?.body.model, "witdev_siwc/gpt-terra-latest");
  const rows = h.core
    .getDbInstance()
    .prepare(
      "SELECT model, billed_model FROM usage_history WHERE api_key_id = ? AND success = 1 AND provider = ? ORDER BY id"
    )
    .all(key.id, NODE) as Array<{ model: string; billed_model: string }>;
  assert.deepEqual(
    rows.map((row) => [row.model, row.billed_model]),
    [
      ["witdev_siwc/gpt-sol-latest", "claude-fable-5"],
      ["witdev_siwc/gpt-terra-latest", "claude-fable-5"],
    ]
  );
});

test("single mode keeps substituting before family fallback and leaves Fable on Claude", async () => {
  await setup(true, "single");
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  budgetRules.replaceModelBudgetRules(key.id, [
    {
      enabled: true,
      priority: 0,
      sourceProvider: "claude",
      sourceFamily: "claude-opus-*",
      weeklyLimitUsd: 0.01,
      targetProvider: "claude",
      targetFamily: "claude-sonnet-*",
    },
  ]);
  await spend(key.id, "claude-opus-4-8");
  const opus = await chat("cc/claude-opus-4-8", key.key);
  assert.equal(opus.status, 200, await opus.clone().text());
  assert.equal(calls.at(-1)?.body.model, "witdev_siwc/gpt-terra-latest");
  const fable = await chat("cc/claude-fable-5", key.key);
  assert.equal(fable.status, 200, await fable.clone().text());
  assert.equal(fable.headers.get("x-omniroute-contingency"), null);
  assert.ok(!(calls.at(-1)?.url || "").includes("/internal/llm/"));
});

test("segmented contingency fails closed when the family alias is unavailable", async () => {
  const { target } = await setup(true, "segmented");
  await providersDb.updateProviderConnection(target.id, { isActive: false });
  const response = await chat("cc/claude-haiku-4-5-20251001");
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal(calls.length, 0);
});

test("segmented contingency keeps non-family and non-Claude models on their route", async () => {
  await setup(true, "segmented");
  await h.seedConnection("openai");
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body || "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return h.buildOpenAIResponse();
  };
  const response = await chat("openai/gpt-4o-mini");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-omniroute-contingency"), null);
  assert.ok(calls.every((call) => !call.url.includes("/internal/llm/")));
});

test("settings schema accepts the segmented mode and rejects unknown modes", () => {
  assert.equal(
    updateSettingsSchema.safeParse({
      claudeSiwcContingency: {
        enabled: true,
        targetModel: TARGET,
        connectionId: "c",
        mode: "segmented",
      },
    }).success,
    true
  );
  assert.equal(
    updateSettingsSchema.safeParse({
      claudeSiwcContingency: {
        enabled: true,
        targetModel: TARGET,
        connectionId: "c",
        mode: "split",
      },
    }).success,
    false
  );
});

test("SIWC-served traffic does not advance the Claude family ladder (it is not Claude spend)", async () => {
  await setup(true, "segmented");
  const key = await h.seedApiKey({ allowedModels: ["cc/*"] });
  budgetRules.replaceModelBudgetRules(key.id, [
    {
      enabled: true,
      priority: 0,
      sourceProvider: "claude",
      sourceFamily: "claude-opus-*",
      weeklyLimitUsd: 0.000001,
      targetProvider: "claude",
      targetFamily: "claude-sonnet-*",
    },
  ]);
  for (let i = 0; i < 2; i += 1) {
    const response = await chat("cc/claude-opus-4-8", key.key);
    assert.equal(response.status, 200, await response.clone().text());
    budgetRouting.clearModelBudgetRoutingCacheForTests();
  }
  // Real family spend counts what Claude actually served; both calls were served by SIWC Sol.
  assert.deepEqual(
    calls.map((call) => call.body.model),
    ["witdev_siwc/gpt-sol-latest", "witdev_siwc/gpt-sol-latest"]
  );
});
