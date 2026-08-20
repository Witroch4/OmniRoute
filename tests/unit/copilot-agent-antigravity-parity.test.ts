// Port of decolua/9router#779: GitHub Copilot Agent Mode & Antigravity "Invalid Argument" parity.
//
// Upstream symptom: VS Code GitHub Copilot Chat (in Agent mode) requests
// `maxOutputTokens` values well above what the Antigravity Cloud Code backend
// will accept for the called model — the backend rejects the call with HTTP 400
// "Invalid Argument" even though the request envelope is otherwise valid.
//
// Fix: clamp `generationConfig.maxOutputTokens` so any oversized client request
// is silently shrunk to a value the upstream accepts. Smaller values are left
// untouched, and the clamp applies independently of the thinkingBudget bump
// logic that already lives in `applyAntigravityGenerationDefaults`.
//
// The clamp used to be a single blanket 16384 for every model on the provider.
// It is now the CALLED MODEL's own pinned ceiling (see
// open-sse/config/antigravityOutputLimits.ts and
// tests/unit/antigravity-per-model-output-cap.test.ts) — the blanket value was
// costing reasoning models three quarters of their real output budget. These
// tests therefore drive the helper with an explicit ceiling, which is what the
// executor passes at the call site.

import test from "node:test";
import assert from "node:assert/strict";

import { __test_applyAntigravityGenerationDefaults as applyAntigravityGenerationDefaults } from "../../open-sse/executors/antigravity.ts";
import { DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS } from "../../open-sse/config/antigravityOutputLimits.ts";

// A real pinned ceiling that is BELOW the default — `gpt-oss-120b-medium`
// advertises 32768. This is the case the Copilot regression is about: a model
// that genuinely cannot serve the oversized envelope.
const LOW_CEILING = 32768;

test("Copilot-style oversized maxOutputTokens is clamped to the model ceiling to avoid Antigravity 400 'Invalid Argument'", () => {
  // Reproduces the upstream-rejected envelope: VS Code GitHub Copilot Chat in
  // Agent mode commonly requests 32K–65K output tokens.
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 65536,
    },
  };

  applyAntigravityGenerationDefaults(request, LOW_CEILING);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, LOW_CEILING);
});

test("maxOutputTokens at or below the ceiling is left untouched", () => {
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 8192,
    },
  };

  applyAntigravityGenerationDefaults(request, LOW_CEILING);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, 8192);
});

test("maxOutputTokens exactly at the ceiling is left untouched (boundary)", () => {
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: LOW_CEILING,
    },
  };

  applyAntigravityGenerationDefaults(request, LOW_CEILING);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, LOW_CEILING);
});

test("a request above the old blanket 16384 now survives on a model that can serve it", () => {
  // The regression this change fixes: 48000 was silently shrunk to 16384 on
  // `agy/gemini-3.7-flash-low`, where reasoning tokens then consumed almost the
  // entire budget and the answer truncated. The model's real ceiling is 65536.
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 48000,
    },
  };

  applyAntigravityGenerationDefaults(request, DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, 48000);
});

test("Clamp is applied even when no generationConfig is provided initially", () => {
  // The defaults helper synthesises generationConfig — the clamp must not crash
  // and must leave a well-formed object behind.
  const request: Record<string, unknown> = {};
  applyAntigravityGenerationDefaults(request, LOW_CEILING);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(typeof gc, "object");
  // No maxOutputTokens was requested — the clamp must not invent one.
  assert.equal(gc.maxOutputTokens, undefined);
});

test("Clamp interacts safely with thinkingBudget bump: bump still wins when budget exceeds tokens, then the clamp still applies to the bumped value", () => {
  // thinkingBudget bumps maxOutputTokens to floor(budget)+1 when it exceeds
  // the requested ceiling; if the bump itself overshoots the model ceiling, the
  // clamp must still apply.
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingBudget: 40000 },
    },
  };

  applyAntigravityGenerationDefaults(request, LOW_CEILING);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, LOW_CEILING);
});

test("a bumped thinkingBudget below the ceiling is preserved, not flattened", () => {
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingBudget: 20000 },
    },
  };

  applyAntigravityGenerationDefaults(request, DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, 20001);
});

test("an absent/invalid ceiling falls back to the default instead of disabling the clamp", () => {
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 200000,
    },
  };

  applyAntigravityGenerationDefaults(request, Number.NaN);

  const gc = request.generationConfig as Record<string, unknown>;
  assert.equal(gc.maxOutputTokens, DEFAULT_ANTIGRAVITY_OUTPUT_TOKENS);
});
