// Gemini's maxOutputTokens includes the thoughts. The old guard raised the cap to
// thinkingBudget + 1, leaving ONE token for the visible answer when the model thinks
// to its budget (Claude Code on agy: max_tokens 32000 + effort high became budget
// 32768 / cap 32769). Gemini ids now keep the client's cap and an answer reserve.
import test from "node:test";
import assert from "node:assert/strict";

import {
  answerReserveFor,
  fitThinkingBudgetIntoOutput,
  reconcileThinkingBudget,
} from "../../open-sse/config/thinkingBudgetFit.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { __test_applyAntigravityGenerationDefaults as applyDefaults } from "../../open-sse/executors/antigravity.ts";

const cfg = (maxOutputTokens: number | undefined, thinkingBudget: number) => ({
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  thinkingConfig: { thinkingBudget, includeThoughts: true },
});
const budgetOf = (c: Record<string, unknown>) =>
  (c.thinkingConfig as { thinkingBudget: number }).thinkingBudget;

test("answer reserve is 25% of the cap, clamped to [1024, 8192]", () => {
  assert.equal(answerReserveFor(32000), 8000);
  assert.equal(answerReserveFor(100000), 8192);
  assert.equal(answerReserveFor(2000), 1024);
});

test("a budget at or over the client's cap shrinks; the cap is respected", () => {
  const c = cfg(32000, 32768);
  fitThinkingBudgetIntoOutput(c);
  assert.equal(c.maxOutputTokens, 32000);
  assert.equal(budgetOf(c), 24000);

  const small = cfg(1000, 8192);
  fitThinkingBudgetIntoOutput(small);
  assert.equal(small.maxOutputTokens, 1000);
  assert.equal(budgetOf(small), 500);
});

test("a cap that already leaves room for the answer is untouched", () => {
  const c = cfg(60000, 32768);
  fitThinkingBudgetIntoOutput(c);
  assert.equal(c.maxOutputTokens, 60000);
  assert.equal(budgetOf(c), 32768);
});

test("no cap: budget + 8192, then the model ceiling wins and the budget refits", () => {
  const open = cfg(undefined, 32768);
  fitThinkingBudgetIntoOutput(open);
  assert.equal(open.maxOutputTokens, 40960);
  assert.equal(budgetOf(open), 32768);

  const ceiled = cfg(undefined, 32768);
  fitThinkingBudgetIntoOutput(ceiled, 16384);
  assert.equal(ceiled.maxOutputTokens, 16384);
  assert.equal(budgetOf(ceiled), 12288);
});

test("Claude, gpt-oss and model-less callers keep the legacy budget + 1", () => {
  for (const model of ["claude-sonnet-5-5-high", "gpt-oss-120b-medium", null]) {
    const c = cfg(1000, 32768);
    reconcileThinkingBudget(c, model);
    assert.equal(c.maxOutputTokens, 32769, String(model));
    assert.equal(budgetOf(c), 32768, String(model));
  }
});

test("OpenAI -> Antigravity Gemini request keeps the client's cap and room for the answer", () => {
  const out = openaiToAntigravityRequest(
    "gemini-3.8-flash-high",
    {
      messages: [{ role: "user", content: "hard problem" }],
      max_completion_tokens: 32000,
      reasoning_effort: "high",
    },
    true,
    { projectId: "proj-1" } as never
  ) as { request: { generationConfig: Record<string, unknown> } };
  const gc = out.request.generationConfig;
  assert.equal(gc.maxOutputTokens, 32000);
  assert.ok(budgetOf(gc) <= 32000 - 8000, `budget ${budgetOf(gc)} must leave the answer reserve`);
});

test("executor defaults refit a Gemini budget after the model-ceiling clamp", () => {
  const request: Record<string, unknown> = { generationConfig: cfg(65536, 60000) };
  applyDefaults(request, 32768, "gemini-3.8-flash-low");
  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, 32768);
  assert.equal(budgetOf(gc), 32768 - 8192);
});
