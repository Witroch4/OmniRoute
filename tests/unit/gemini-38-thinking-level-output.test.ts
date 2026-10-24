/**
 * Upstream #13463: Gemini 3.8 Flash talks thinking_level (low|medium|high), not the 3.7
 * numeric thinkingBudget Omni still emits. (Fork: 3.8 keeps the numeric budget — see the
 * note above the 3.8 cases; Gemini 4 takes thinkingLevel.) includeThoughts:true also shares
 * maxOutputTokens with hidden thoughts, so a review-sized max_tokens=65536
 * request starves visible completion (finish=length, ~2.6k text).
 *
 * Tests hit openaiToGeminiRequest / openaiToAntigravityRequest / claudeToGeminiRequest
 * at the write sites so a helper cannot stay green with the call gone.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { openaiToGeminiRequest, openaiToAntigravityRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { gemini38ThinkingLevelFromBudget } =
  await import("../../open-sse/services/thinkingBudget.ts");

type ThinkingConfig = {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
};

type GeminiReq = {
  generationConfig?: {
    maxOutputTokens?: number;
    thinkingConfig?: ThinkingConfig;
  };
};

type EnvelopeReq = {
  request?: {
    generationConfig?: {
      maxOutputTokens?: number;
      thinkingConfig?: ThinkingConfig;
    };
  };
};

const reviewBody = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "review diff" }],
  max_tokens: 65536,
  ...extra,
});

function thinkingConfigOf(model: string, extra: Record<string, unknown> = {}) {
  const result = openaiToGeminiRequest(model, reviewBody(extra), false) as GeminiReq;
  return result.generationConfig?.thinkingConfig;
}

// Fork divergence (open-sse/config/thinkingBudgetFit.ts `geminiUsesThinkingLevel`):
// upstream #13463 sends Gemini 3.8 `thinkingLevel`; the fork keeps the numeric
// `thinkingBudget` for 3.8 (tier-suffix default + thinkingBudgetFit's answer reserve on
// Antigravity, both measured on agy/gemini-3.8-flash-*) and only Gemini 4 (#16603) takes
// the level. Exactly one knob per request either way. The 3.8 cases below lock the fork
// contract; the thinkingLevel write sites stay covered through Gemini 4 ids.
const numericOnly = (tc: ThinkingConfig | undefined, label: string) => {
  assert.equal(tc?.thinkingLevel, undefined, `${label}: no thinkingLevel`);
  assert.ok((tc?.thinkingBudget ?? 0) > 0, `${label}: numeric thinkingBudget`);
};

test("gemini-3.8-flash tiers keep a numeric thinkingBudget, never thinkingLevel (fork)", () => {
  for (const [model, effort] of [
    ["gemini-3.8-flash-high", "high"],
    ["gemini-3.8-flash-medium", "medium"],
    ["gemini-3.8-flash-low", "low"],
    ["agy/gemini-3.8-flash-high", "high"],
  ]) {
    const tc = thinkingConfigOf(model, { reasoning_effort: effort });
    numericOnly(tc, model);
    assert.equal(tc?.includeThoughts, true, model);
  }
  for (const model of ["gemini-3.8-flash", "gemini-3.8-flash-tiered", "gemini-3.8-flash-high"]) {
    numericOnly(thinkingConfigOf(model), `${model} (default)`);
  }
});

test("gemini-3.8 review-shaped request keeps max_tokens and routes thoughts (fork)", () => {
  const result = openaiToGeminiRequest("gemini-3.8-flash-high", reviewBody(), false) as GeminiReq;
  assert.equal(result.generationConfig?.maxOutputTokens, 65536);
  numericOnly(result.generationConfig?.thinkingConfig, "default");
  assert.equal(result.generationConfig?.thinkingConfig?.includeThoughts, true);
});

test("gemini-4 includeThoughts is set only when the client asked for thoughts", () => {
  const silent = thinkingConfigOf("vertex/gemini-4-argon", { reasoning_effort: "high" });
  assert.equal(silent?.includeThoughts, undefined);

  const asked = thinkingConfigOf("vertex/gemini-4-argon", {
    reasoning_effort: "high",
    includeThoughts: true,
  });
  assert.equal(asked?.includeThoughts, true);
  assert.equal(asked?.thinkingLevel, "high");
});

test("gemini-3.8 reasoning_effort none stays an explicit off-switch", () => {
  const tc = thinkingConfigOf("gemini-3.8-flash-high", { reasoning_effort: "none" });
  assert.equal(tc?.thinkingBudget, 0);
  assert.equal(tc?.includeThoughts, false);
  assert.equal(tc?.thinkingLevel, undefined);
});

test("gemini-2.5-flash still emits numeric thinkingBudget (3.8 gate)", () => {
  const result = openaiToGeminiRequest(
    "gemini-2.5-flash",
    reviewBody({ reasoning_effort: "high" }),
    false
  ) as GeminiReq;
  assert.equal(result.generationConfig?.thinkingConfig?.thinkingBudget, 24576);
  assert.equal(result.generationConfig?.thinkingConfig?.includeThoughts, true);
  assert.equal(result.generationConfig?.thinkingConfig?.thinkingLevel, undefined);
});

test("Antigravity envelope keeps maxOutputTokens 65536 and a fitted budget for 3.8 (fork)", () => {
  const result = openaiToAntigravityRequest(
    "gemini-3.8-flash-high",
    reviewBody({ reasoning_effort: "high" }),
    false,
    { projectId: "proj-gemini38" }
  ) as EnvelopeReq;
  const gc = result.request?.generationConfig;
  assert.equal(gc?.maxOutputTokens, 65536);
  assert.equal(gc?.thinkingConfig?.thinkingLevel, undefined);
  const budget = gc?.thinkingConfig?.thinkingBudget ?? 0;
  assert.ok(budget > 0 && budget <= 65536 - 8192, `budget ${budget} leaves the answer reserve`);
  assert.equal(gc?.thinkingConfig?.includeThoughts, true);
});

test("Antigravity envelope sends Gemini 4 thinkingLevel and no budget", () => {
  const result = openaiToAntigravityRequest(
    "gemini-4-argon",
    reviewBody({ reasoning_effort: "high" }),
    false,
    { projectId: "proj-gemini4" }
  ) as EnvelopeReq;
  const tc = result.request?.generationConfig?.thinkingConfig;
  assert.equal(tc?.thinkingLevel, "high");
  assert.equal(tc?.thinkingBudget, undefined);
});

test("gemini-3.8 thinking.budget_tokens keeps the numeric budget (fork)", () => {
  const tc = thinkingConfigOf("gemini-3.8-flash-high", {
    thinking: { type: "enabled", budget_tokens: 24576 },
  });
  assert.equal(tc?.thinkingBudget, 24576);
  assert.equal(tc?.thinkingLevel, undefined);
  assert.equal(tc?.includeThoughts, true);
});

test("gemini-4 thinking.budget_tokens maps thinkingLevel, not thinkingBudget", () => {
  const tc = thinkingConfigOf("vertex/gemini-4-argon", {
    thinking: { type: "enabled", budget_tokens: 24576 },
  });
  assert.equal(tc?.thinkingLevel, "high");
  assert.equal(tc?.thinkingBudget, undefined);
  assert.equal(tc?.includeThoughts, undefined);
});

test("claude-to-gemini gemini-3.8 keeps the numeric budget on both thinking paths (fork)", () => {
  const viaBudget = claudeToGeminiRequest(
    "gemini-3.8-flash-high",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "review diff" }] }],
      max_tokens: 65536,
      thinking: { type: "enabled", budget_tokens: 24576 },
    },
    false
  ) as GeminiReq;
  assert.equal(viaBudget.generationConfig?.thinkingConfig?.thinkingBudget, 24576);
  assert.equal(viaBudget.generationConfig?.thinkingConfig?.thinkingLevel, undefined);

  const viaEffort = claudeToGeminiRequest(
    "gemini-3.8-flash-high",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "review diff" }] }],
      max_tokens: 65536,
      output_config: { effort: "high" },
    },
    false
  ) as GeminiReq;
  assert.equal(viaEffort.generationConfig?.maxOutputTokens, 65536);
  assert.ok((viaEffort.generationConfig?.thinkingConfig?.thinkingBudget ?? 0) > 0);
  assert.equal(viaEffort.generationConfig?.thinkingConfig?.thinkingLevel, undefined);
  assert.equal(viaEffort.generationConfig?.thinkingConfig?.includeThoughts, true);
});

test("claude-to-gemini gemini-4 output_config.effort emits thinkingLevel, not includeThoughts", () => {
  const result = claudeToGeminiRequest(
    "vertex/gemini-4-argon",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "review diff" }] }],
      max_tokens: 65536,
      output_config: { effort: "high" },
    },
    false
  ) as GeminiReq;
  assert.equal(result.generationConfig?.thinkingConfig?.thinkingLevel, "high");
  assert.equal(result.generationConfig?.thinkingConfig?.thinkingBudget, undefined);
  assert.equal(result.generationConfig?.thinkingConfig?.includeThoughts, undefined);
});

test("gemini38ThinkingLevelFromBudget rejects budget <= 0", () => {
  assert.throws(() => gemini38ThinkingLevelFromBudget("gemini-3.8-flash-high", 0), RangeError);
  assert.throws(() => gemini38ThinkingLevelFromBudget("gemini-3.8-flash-high", -1), RangeError);
});

test("gemini38ThinkingLevelFromBudget maps 1 and 1024 to low", () => {
  assert.equal(gemini38ThinkingLevelFromBudget("gemini-3.8-flash-high", 1), "low");
  assert.equal(gemini38ThinkingLevelFromBudget("gemini-3.8-flash-high", 1024), "low");
});

test("gemini38ThinkingLevelFromBudget maps 1025 through medium cap to medium", () => {
  assert.equal(gemini38ThinkingLevelFromBudget("gemini-3.8-flash-medium", 1025), "medium");
  assert.equal(gemini38ThinkingLevelFromBudget("gemini-3.8-flash-medium", 8192), "medium");
});

test("gemini38ThinkingLevelFromBudget maps above medium cap to high", () => {
  assert.equal(gemini38ThinkingLevelFromBudget("gemini-3.8-flash-medium", 8193), "high");
  assert.equal(gemini38ThinkingLevelFromBudget("gemini-3.8-flash-high", 24576), "high");
});

test("vertex/gemini-4-argon emits thinkingLevel, never thinkingBudget (#16603)", () => {
  const silent = thinkingConfigOf("vertex/gemini-4-argon");
  assert.equal(silent?.thinkingLevel, "medium");
  assert.equal(silent?.thinkingBudget, undefined);

  const low = thinkingConfigOf("vertex/gemini-4-argon", { reasoning_effort: "low" });
  assert.equal(low?.thinkingLevel, "low");
  assert.equal(low?.thinkingBudget, undefined);

  const high = thinkingConfigOf("vertex/gemini-4-argon", { reasoning_effort: "high" });
  assert.equal(high?.thinkingLevel, "high");
  assert.equal(high?.thinkingBudget, undefined);

  const claudeReq = claudeToGeminiRequest("vertex/gemini-4-argon", {
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 16000 },
  }) as GeminiReq;
  assert.equal(claudeReq.generationConfig?.thinkingConfig?.thinkingLevel, "high");
  assert.equal(claudeReq.generationConfig?.thinkingConfig?.thinkingBudget, undefined);
});
