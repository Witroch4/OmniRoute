import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { resolveCanonicalProviderModel } from "../../open-sse/services/model.ts";
import { getStaticModelsForProvider } from "../../src/lib/providers/staticModels.ts";
import { DEFAULT_PRICING } from "../../src/shared/constants/pricing.ts";

test("Pollinations catalog mirrors the current public text model lineup", () => {
  const models = getModelsByProviderId("pollinations");
  const ids = new Set(models.map((model) => model.id));
  const names = models.map((model) => model.name);

  assert.ok(ids.has("openai-fast"));
  assert.ok(ids.has("openai-large"));
  assert.ok(ids.has("perplexity-fast"));
  assert.ok(ids.has("qwen-coder-large"));
  assert.ok(ids.has("claude-large"));
  assert.equal(ids.has("llama"), false);
  assert.equal(
    names.some((name) => /GPT-5 via Pollinations/i.test(name)),
    false
  );
});

test("NVIDIA catalog includes the current hosted models and GPT OSS 120B alias resolution", () => {
  const ids = new Set(getModelsByProviderId("nvidia").map((model) => model.id));

  assert.ok(ids.has("moonshotai/kimi-k3"));
  assert.ok(ids.has("deepseek-ai/deepseek-v4-pro-0813"));
  assert.ok(ids.has("deepseek-ai/deepseek-v4-flash-0731"));
  assert.ok(ids.has("nvidia/nemotron-3.5-lightning-30b-a3b"));
  assert.ok(ids.has("meta/muse-glimmer-30b"));
  assert.ok(ids.has("google/diffusiongemma-26b-a4b-it"));
  assert.ok(ids.has("openai/gpt-oss-120b"));
  assert.ok(ids.has("nvidia/nemotron-3-super-120b-a12b"));

  assert.deepEqual(resolveCanonicalProviderModel("nvidia", "gpt-oss-120b"), {
    provider: "nvidia",
    model: "openai/gpt-oss-120b",
  });
});

test("Fable 5 catalog exposes claude-fable-5 in cc — but NOT via Kiro (fabricated)", () => {
  // claude-fable-5 is a real Claude flagship served by the Claude Code (cc) channel,
  // but Kiro's upstream never served it — it had been copied verbatim into the Kiro
  // registry from OmniRoute's own Anthropic catalog and returned upstream 400
  // "Invalid model". #6170 removed the fabricated Kiro copy.
  const ccIds = new Set(getModelsByProviderId("cc").map((m) => m.id));
  assert.ok(ccIds.has("claude-fable-5"), "cc must expose claude-fable-5");

  const ccPricing = (DEFAULT_PRICING as Record<string, Record<string, unknown>>).cc;
  assert.ok(ccPricing["claude-fable-5"], "cc pricing must include claude-fable-5");

  const kiroIds = new Set(getModelsByProviderId("kiro").map((m) => m.id));
  assert.equal(
    kiroIds.has("claude-fable-5"),
    false,
    "kiro must NOT expose claude-fable-5 (fabricated)"
  );
});

test("Opus 5 catalog is limited to verified first-party and web providers", () => {
  // Fork: not on Copilot — this account's picker answers `400 The requested model is not
  // supported` for claude-opus-5 (registry/github/index.ts), so github does not list it.
  for (const providerId of ["claude", "claude-web", "anthropic"]) {
    const model = getModelsByProviderId(providerId).find((entry) => entry.id === "claude-opus-5");
    assert.ok(model, `${providerId} must expose claude-opus-5`);
  }

  const claude = getModelsByProviderId("claude").find((entry) => entry.id === "claude-opus-5");
  assert.equal(claude?.contextLength, 1000000);
  assert.equal(claude?.maxOutputTokens, 128000);
  assert.ok(
    getStaticModelsForProvider("claude")?.some((entry) => entry.id === "claude-opus-5"),
    "claude OAuth discovery must expose claude-opus-5"
  );

  const githubIds = new Set(getModelsByProviderId("github").map((entry) => entry.id));
  assert.equal(githubIds.has("claude-opus-5"), false, "policy-disabled on this Copilot account");

  const kiroIds = new Set(getModelsByProviderId("kiro").map((entry) => entry.id));
  assert.equal(kiroIds.has("claude-opus-5"), false, "do not fabricate Kiro availability");

  const pricing = DEFAULT_PRICING as Record<string, Record<string, unknown>>;
  for (const providerId of ["cc", "gh", "anthropic"]) {
    const price = pricing[providerId]["claude-opus-5"] as { input: number; output: number };
    assert.equal(price.input, 5.0, `${providerId} Opus 5 input price`);
    assert.equal(price.output, 25.0, `${providerId} Opus 5 output price`);
  }
});

test("Sonnet 5 catalog exposes claude-sonnet-5 across cc/anthropic/blackbox with Sonnet-tier pricing", () => {
  // Sonnet 5 must be wired everywhere the last flagship (Fable 5) was — but as a
  // Sonnet-tier model: $3/$15 pricing (NOT the Opus/Fable $15/$75), 1M ctx / 128K out.
  //
  // Kiro is deliberately excluded here (2026-07-25): live-tested against two real
  // Amazon Q/Kiro connections and claude-sonnet-5 400'd "Invalid model" on both,
  // every time — Kiro's catalog has no "Sonnet 5", only "Sonnet 4.5" and a separate
  // "Sonnet 4" regular tier. See the "Kiro exposes claude-sonnet-4" test below.
  for (const providerId of ["cc", "anthropic", "blackbox"]) {
    const ids = new Set(getModelsByProviderId(providerId).map((m) => m.id));
    assert.ok(ids.has("claude-sonnet-5"), `${providerId} must expose claude-sonnet-5`);
  }

  const kiroIds = new Set(getModelsByProviderId("kiro").map((m) => m.id));
  assert.equal(
    kiroIds.has("claude-sonnet-5"),
    false,
    "kiro must NOT expose claude-sonnet-5 (live-verified 400)"
  );

  const ccPricing = (DEFAULT_PRICING as Record<string, Record<string, unknown>>).cc;
  assert.ok(ccPricing["claude-sonnet-5"], "cc pricing must include claude-sonnet-5");
});

test("Kiro exposes claude-sonnet-4 (regular tier) with Sonnet-tier pricing, not claude-sonnet-5", () => {
  const kiroSonnet4 = getModelsByProviderId("kiro").find((m) => m.id === "claude-sonnet-4");
  assert.ok(kiroSonnet4, "kiro must expose claude-sonnet-4");
  assert.equal(kiroSonnet4?.contextLength, 200000);
  assert.equal(kiroSonnet4?.maxOutputTokens, 64000);

  const kiroPricing = (DEFAULT_PRICING as Record<string, Record<string, unknown>>).kiro;
  const kiroSonnet4Price = kiroPricing["claude-sonnet-4"] as { input: number; output: number };
  assert.ok(kiroSonnet4Price, "kiro pricing must include claude-sonnet-4");
  assert.equal(kiroSonnet4Price.input, 3.0);
  assert.equal(kiroSonnet4Price.output, 15.0);
});

test("Kiro catalog does NOT expose Claude Opus (fabricated — Kiro upstream has no Opus)", () => {
  // Kiro's real upstream never served any Opus model; the Opus 4.8/4.7/4.6 ids had been
  // copied into the Kiro registry from OmniRoute's Anthropic catalog and returned upstream
  // 400 "Invalid model. Please select a different model". #6170 removed them.
  const ids = new Set(getModelsByProviderId("kiro").map((model) => model.id));

  assert.equal(
    ids.has("claude-opus-4.8"),
    false,
    "kiro must NOT expose claude-opus-4.8 (fabricated)"
  );
  assert.equal(
    ids.has("claude-opus-4.7"),
    false,
    "kiro must NOT expose claude-opus-4.7 (fabricated)"
  );
  assert.equal(
    ids.has("claude-opus-4.6"),
    false,
    "kiro must NOT expose claude-opus-4.6 (fabricated)"
  );
});

test("Every Kiro registry model resolves a non-zero pricing row (no $0.00 usage)", async () => {
  const { getPricingForModel } = await import("../../src/shared/constants/pricing.ts");
  const models = getModelsByProviderId("kiro");

  assert.ok(models.length > 0, "kiro must expose models");

  for (const model of models) {
    const pricing = getPricingForModel("kiro", model.id) as {
      input?: number;
      output?: number;
    } | null;
    assert.ok(pricing, `kiro pricing must include "${model.id}"`);
    assert.equal(
      typeof pricing?.input === "number" && typeof pricing?.output === "number",
      true,
      `kiro pricing for "${model.id}" must have numeric input/output`
    );
  }

  // Regression guard: Kiro's real Sonnet is 4.5 (the "4.6" id was fabricated — #6170) and
  // must carry Sonnet-tier pricing ($3/$15).
  const sonnet45 = getPricingForModel("kiro", "claude-sonnet-4.5") as {
    input: number;
    output: number;
  } | null;
  assert.ok(sonnet45, "kiro pricing must include claude-sonnet-4.5");
  assert.equal(sonnet45?.input, 3.0);
  assert.equal(sonnet45?.output, 15.0);
});

test("Every OpenAI registry model resolves a non-zero pricing row (alias: openai)", async () => {
  const { getPricingForModel } = await import("../../src/shared/constants/pricing.ts");
  const models = getModelsByProviderId("openai");
  assert.ok(models.length > 0, "openai must expose models");

  for (const model of models) {
    const pricing = getPricingForModel("openai", model.id) as {
      input?: number;
      output?: number;
    } | null;
    assert.ok(pricing, `openai pricing must include "${model.id}"`);
    assert.equal(
      typeof pricing?.input === "number" && typeof pricing?.output === "number",
      true,
      `openai pricing for "${model.id}" must have numeric input/output`
    );
  }
});

test("Every Codex registry model resolves a non-zero pricing row (alias: cx)", async () => {
  const { getPricingForModel } = await import("../../src/shared/constants/pricing.ts");
  const models = getModelsByProviderId("codex");
  assert.ok(models.length > 0, "codex must expose models");

  for (const model of models) {
    // Codex pricing lives under the "cx" alias (its DEFAULT_PRICING key).
    const pricing = getPricingForModel("cx", model.id) as {
      input?: number;
      output?: number;
    } | null;
    assert.ok(pricing, `cx pricing must include codex model "${model.id}"`);
    assert.equal(
      typeof pricing?.input === "number" && typeof pricing?.output === "number",
      true,
      `cx pricing for "${model.id}" must have numeric input/output`
    );
  }
});
