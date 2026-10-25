/**
 * Fork — a Claude effort suffix the live-catalog gate already folded must reach the
 * upstream exactly like an unfolded one.
 *
 * `lookupModelMeta` folds `gh/claude-sonnet-5.5-medium` to `claude-sonnet-5.5` with
 * `resolvedThinkingEffort: "medium"` (the Copilot registry declares its tiers). chatCore only
 * applied that value through `applyDefaultReasoningEffort`, which runs for OpenAI targets;
 * Copilot Claude targets the Claude format, so the tier the client picked was dropped
 * (production call_logs on 2026-10-25: no reasoning_effort on the folded request, while the
 * same model with an explicit reasoning_effort carried it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyClaudeEffortVariant } from "../../open-sse/handlers/chatCore/claudeEffortVariant.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

test("a folded Claude effort becomes reasoning_effort before translation", () => {
  const body: Record<string, unknown> = { model: "claude-sonnet-5.5", messages: [] };
  const result = applyClaudeEffortVariant({
    provider: "github",
    effectiveModel: "claude-sonnet-5.5",
    body,
    sourceFormat: FORMATS.OPENAI,
    resolvedThinkingEffort: "medium",
  });
  assert.equal(result.effectiveModel, "claude-sonnet-5.5");
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(body.model, "claude-sonnet-5.5");
  assert.match(result.log ?? "", /reasoning_effort=medium/);
});

test("an explicit client effort still wins over a folded suffix", () => {
  const body: Record<string, unknown> = {
    model: "claude-sonnet-5.5",
    messages: [],
    reasoning_effort: "low",
  };
  applyClaudeEffortVariant({
    provider: "github",
    effectiveModel: "claude-sonnet-5.5",
    body,
    sourceFormat: FORMATS.OPENAI,
    resolvedThinkingEffort: "high",
  });
  assert.equal(body.reasoning_effort, "low");
});

test("native Claude passthrough keeps its own thinking config", () => {
  const body: Record<string, unknown> = { model: "claude-sonnet-5.5", messages: [] };
  applyClaudeEffortVariant({
    provider: "github",
    effectiveModel: "claude-sonnet-5.5",
    body,
    sourceFormat: FORMATS.CLAUDE,
    resolvedThinkingEffort: "high",
  });
  assert.equal(body.reasoning_effort, undefined);
});

test("non-Claude folds are left to applyDefaultReasoningEffort", () => {
  const body: Record<string, unknown> = { model: "gpt-5.6-luna", messages: [] };
  const result = applyClaudeEffortVariant({
    provider: "github",
    effectiveModel: "gpt-5.6-luna",
    body,
    sourceFormat: FORMATS.OPENAI,
    resolvedThinkingEffort: "medium",
  });
  assert.deepEqual(result, { effectiveModel: "gpt-5.6-luna", log: null });
  assert.equal(body.reasoning_effort, undefined);
});

test("a folded value that is not a Claude effort level is ignored", () => {
  for (const level of ["none", "ultra", ""]) {
    const body: Record<string, unknown> = { model: "claude-sonnet-5.5", messages: [] };
    applyClaudeEffortVariant({
      provider: "github",
      effectiveModel: "claude-sonnet-5.5",
      body,
      sourceFormat: FORMATS.OPENAI,
      resolvedThinkingEffort: level,
    });
    assert.equal(body.reasoning_effort, undefined, level);
  }
});

test("cursor keeps its literal ids even with a folded effort", () => {
  const body: Record<string, unknown> = { model: "claude-opus-5", messages: [] };
  const result = applyClaudeEffortVariant({
    provider: "cursor",
    effectiveModel: "claude-opus-5",
    body,
    sourceFormat: FORMATS.OPENAI,
    resolvedThinkingEffort: "high",
  });
  assert.deepEqual(result, { effectiveModel: "claude-opus-5", log: null });
  assert.equal(body.reasoning_effort, undefined);
});
