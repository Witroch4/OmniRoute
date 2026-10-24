import assert from "node:assert/strict";
import test from "node:test";

const { openaiToGeminiRequest, tierSuffixThinkingBudget } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
// Since v3.8.53 the model specs carry the real Gemini 3.8 Flash limits (thinkingBudgetCap
// 24576, per-tier defaultThinkingBudget), so budgets above the cap are clamped. The
// expectations below go through the same helpers instead of hardcoding a pre-spec 32768.
const { capThinkingBudget, getDefaultThinkingBudget } =
  await import("../../src/lib/modelCapabilities.ts");
const historicalDefault = (model: string) =>
  getDefaultThinkingBudget(model) || capThinkingBudget(model, 24576);

function build(model: string, extra: Record<string, unknown> = {}) {
  const r = openaiToGeminiRequest(
    model,
    { messages: [{ role: "user", content: "x" }], max_tokens: 30000, ...extra },
    false,
    {}
  ) as {
    generationConfig: {
      thinkingConfig?: { thinkingBudget: number; includeThoughts: boolean };
    };
  };
  return r.generationConfig.thinkingConfig;
}

// Antigravity's `gemini-3.8-flash-low`, given the blanket 24576 default and no
// knob from the client, spent ~29k of a 30k max_tokens thinking and truncated
// its JSON (measured 2026-09-10, OAB scout). The id already says "low".
test("a silent client on a tiered id gets the tier's budget, not the blanket default", () => {
  assert.equal(build("gemini-3.8-flash-low")?.thinkingBudget, 1024);
  assert.equal(build("gemini-3.8-flash-medium")?.thinkingBudget, 8192);
  assert.equal(
    build("gemini-3.8-flash-high")?.thinkingBudget,
    capThinkingBudget("gemini-3.8-flash-high", 32768)
  );
  for (const m of ["gemini-3.8-flash-low", "gemini-3.8-flash-high"]) {
    assert.equal(build(m)?.includeThoughts, true, `${m}: thoughts must still be routed`);
  }
});

test("an untiered id keeps the historical default", () => {
  assert.equal(build("gemini-3.8-flash")?.thinkingBudget, historicalDefault("gemini-3.8-flash"));
  assert.equal(build("gemini-2.5-pro")?.thinkingBudget, historicalDefault("gemini-2.5-pro"));
  assert.equal(tierSuffixThinkingBudget("gemini-2.5-pro"), null);
});

test("an explicit reasoning_effort still wins over the suffix", () => {
  const high = build("gemini-3.8-flash-low", { reasoning_effort: "high" })?.thinkingBudget;
  assert.equal(high, capThinkingBudget("gemini-3.8-flash-low", 32768));
  assert.ok((high ?? 0) > 1024, "the explicit effort, not the -low suffix, sets the budget");
  assert.equal(build("gemini-3.8-flash-high", { reasoning_effort: "none" })?.thinkingBudget, 0);
});

test("an explicit thinking.budget_tokens still wins over the suffix", () => {
  const tc = build("gemini-3.8-flash-low", {
    thinking: { type: "enabled", budget_tokens: 5000 },
  });
  assert.equal(tc?.thinkingBudget, 5000);
});

test("suffix parsing is anchored at the end of the id", () => {
  assert.equal(tierSuffixThinkingBudget("gemini-3.8-flash-low"), 1024);
  assert.equal(tierSuffixThinkingBudget("gemini-3.5-flash-extra-low"), 1024);
  assert.equal(
    tierSuffixThinkingBudget("gemini-3.8-flash-xhigh"),
    capThinkingBudget("gemini-3.8-flash-xhigh", 32768)
  );
  assert.equal(tierSuffixThinkingBudget("gemini-3.8-flash"), null);
  assert.equal(
    tierSuffixThinkingBudget("gemini-3.8-flash-low-preview"),
    null,
    "tier not at the end"
  );
  assert.equal(
    tierSuffixThinkingBudget("gemini-lowlatency"),
    null,
    "'low' inside a word is not a tier"
  );
  assert.equal(tierSuffixThinkingBudget(""), null);
});
