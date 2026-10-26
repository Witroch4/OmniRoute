/**
 * Fork — an effort tier folded off a model id must reach Claude and Responses upstreams.
 *
 * `lookupModelMeta` folds `<base>-<tier>` onto the base with `resolvedThinkingEffort`, and
 * prepareUpstreamBody applies it per attempt with applyDefaultReasoningEffort, which only runs
 * for chat-completions targets. Measured on opencode-go/gpt-6-luna, 4 samples each: suffix
 * `-max` 232–574 reasoning tokens (the default), explicit reasoning_effort=max 892–3138; and
 * Copilot `claude-sonnet-5.5-medium` reached the upstream with no reasoning_effort at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFoldedEffort } from "../../open-sse/handlers/chatCore/foldedEffort.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

type Call = Parameters<typeof applyFoldedEffort>[0];

function run(overrides: Partial<Call> & { body: Record<string, unknown> }) {
  return applyFoldedEffort({
    provider: "opencode-go",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    resolvedThinkingEffort: "max",
    ...overrides,
  });
}

test("a chat-completions request gets the folded tier as reasoning_effort on a Responses target", () => {
  const body: Record<string, unknown> = { model: "gpt-6-luna", messages: [] };
  assert.equal(run({ body }), true);
  assert.equal(body.reasoning_effort, "max");
});

test("a Responses request gets the folded tier inside reasoning, keeping its other fields", () => {
  const body: Record<string, unknown> = {
    model: "gpt-6-luna",
    input: [],
    reasoning: { summary: "auto" },
  };
  assert.equal(run({ body, sourceFormat: FORMATS.OPENAI_RESPONSES }), true);
  assert.deepEqual(body.reasoning, { summary: "auto", effort: "max" });
  assert.equal(body.reasoning_effort, undefined);
});

test("a Claude target gets a Claude effort level as reasoning_effort", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    const body: Record<string, unknown> = { model: "claude-sonnet-5.5", messages: [] };
    assert.equal(
      run({
        body,
        provider: "github",
        targetFormat: FORMATS.CLAUDE,
        resolvedThinkingEffort: level,
      }),
      true,
      level
    );
    assert.equal(body.reasoning_effort, level);
  }
});

test("a Claude target ignores a folded value that is not a Claude effort level", () => {
  for (const level of ["none", "minimal", "ultra", ""]) {
    const body: Record<string, unknown> = { model: "claude-sonnet-5.5", messages: [] };
    assert.equal(
      run({
        body,
        provider: "github",
        targetFormat: FORMATS.CLAUDE,
        resolvedThinkingEffort: level,
      }),
      false,
      level
    );
    assert.equal(body.reasoning_effort, undefined);
  }
});

test("chat-completions targets are left to prepareUpstreamBody, which scopes the tier per attempt", () => {
  // Writing the tier here for an OpenAI target made it travel with the shared body to a family
  // fallback (tests/unit/suffix-effort-propagation.test.ts: "suffix" mode).
  const body: Record<string, unknown> = { model: "claude-sonnet-4.6", messages: [] };
  assert.equal(run({ body, targetFormat: FORMATS.OPENAI, resolvedThinkingEffort: "high" }), false);
  assert.equal(body.reasoning_effort, undefined);
});

test("an explicit client effort always wins", () => {
  for (const explicit of [
    { reasoning_effort: "low" },
    { reasoning: { effort: "low" } },
    { thinking: { type: "enabled" } },
    { output_config: { effort: "low" } },
  ]) {
    const body: Record<string, unknown> = { model: "gpt-6-luna", messages: [], ...explicit };
    const before = JSON.stringify(body);
    assert.equal(run({ body }), false);
    assert.equal(JSON.stringify(body), before);
  }
  const responses: Record<string, unknown> = { input: [], reasoning: { effort: "low" } };
  assert.equal(run({ body: responses, sourceFormat: FORMATS.OPENAI_RESPONSES }), false);
  assert.deepEqual(responses.reasoning, { effort: "low" });
});

test("Codex keeps its own policy for the folded tier", () => {
  const body: Record<string, unknown> = { model: "gpt-6-luna", messages: [] };
  assert.equal(run({ body, provider: "codex" }), false);
  assert.equal(body.reasoning_effort, undefined);
});

test("native Claude-format sources are left alone", () => {
  const body: Record<string, unknown> = { model: "m", messages: [] };
  assert.equal(
    run({ body, provider: "github", sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.CLAUDE }),
    false
  );
  assert.equal(body.reasoning_effort, undefined);
});

test("other targets are untouched", () => {
  for (const targetFormat of [FORMATS.GEMINI, FORMATS.OPENAI]) {
    const body: Record<string, unknown> = { model: "m", messages: [] };
    assert.equal(run({ body, targetFormat }), false, targetFormat);
    assert.equal(body.reasoning_effort, undefined);
  }
});

test("nothing folded means nothing written", () => {
  for (const resolvedThinkingEffort of [undefined, null, ""]) {
    const body: Record<string, unknown> = { model: "m", messages: [] };
    assert.equal(run({ body, resolvedThinkingEffort }), false);
    assert.equal(body.reasoning_effort, undefined);
  }
});
