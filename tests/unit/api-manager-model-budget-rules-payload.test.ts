import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelBudgetRulesSavePayload,
  resolveModelBudgetRulesSave,
} from "../../src/app/(dashboard)/dashboard/api-manager/modelBudgetRulesPayload.ts";
import type {
  ModelBudgetRuleDraft,
  ModelBudgetRulesLoadStatus,
} from "../../src/app/(dashboard)/dashboard/api-manager/components/ModelBudgetRoutingSettings.tsx";

function draft(overrides: Partial<ModelBudgetRuleDraft> = {}): ModelBudgetRuleDraft {
  return {
    enabled: true,
    sourceProvider: "cc",
    sourceFamily: "claude-opus-*",
    weeklyLimitUsd: "100",
    targetProvider: "cc",
    targetFamily: "claude-sonnet-*",
    ...overrides,
  };
}

test("a complete draft row is sent with weeklyLimitUsd coerced to a number", () => {
  const payload = buildModelBudgetRulesSavePayload([draft()]);
  assert.deepEqual(payload, {
    rules: [
      {
        enabled: true,
        sourceProvider: "cc",
        sourceFamily: "claude-opus-*",
        weeklyLimitUsd: 100,
        targetProvider: "cc",
        targetFamily: "claude-sonnet-*",
      },
    ],
  });
  assert.equal(typeof payload.rules[0].weeklyLimitUsd, "number");
});

test("an empty draft list clears all rules (legitimate PUT rules: [])", () => {
  assert.deepEqual(buildModelBudgetRulesSavePayload([]), { rules: [] });
});

test("rows missing sourceProvider, sourceFamily, targetProvider, or targetFamily are dropped silently", () => {
  const rows = [
    draft({ sourceProvider: "" }),
    draft({ sourceFamily: "" }),
    draft({ targetProvider: "" }),
    draft({ targetFamily: "" }),
  ];
  assert.deepEqual(buildModelBudgetRulesSavePayload(rows), { rules: [] });
});

test("rows with a non-positive or non-numeric weeklyLimitUsd are dropped silently", () => {
  const rows = [
    draft({ weeklyLimitUsd: "" }),
    draft({ weeklyLimitUsd: "0" }),
    draft({ weeklyLimitUsd: "-5" }),
    draft({ weeklyLimitUsd: "not-a-number" }),
  ];
  assert.deepEqual(buildModelBudgetRulesSavePayload(rows), { rules: [] });
});

test("a half-filled draft row mixed with a complete one keeps only the complete row, in order", () => {
  const complete = draft();
  const incomplete = draft({ targetFamily: "" });
  const payload = buildModelBudgetRulesSavePayload([incomplete, complete]);
  assert.equal(payload.rules.length, 1);
  assert.equal(payload.rules[0].sourceFamily, "claude-opus-*");
});

test("enabled: false rows are preserved (only completeness/limit gate dropping, not the enabled flag)", () => {
  const payload = buildModelBudgetRulesSavePayload([draft({ enabled: false })]);
  assert.equal(payload.rules.length, 1);
  assert.equal(payload.rules[0].enabled, false);
});

// ─── fix round 1 (review, Finding 1 — Critical): whitespace-only fields must not
// pass the completeness check, and must not be sent verbatim (untrimmed) either. ──

test("a whitespace-only sourceFamily is treated as missing and the row is dropped", () => {
  const payload = buildModelBudgetRulesSavePayload([draft({ sourceFamily: "   " })]);
  assert.deepEqual(payload, { rules: [] });
});

test("whitespace-only values are rejected the same way in every string field", () => {
  const rows = [
    draft({ sourceProvider: " " }),
    draft({ sourceFamily: "\t" }),
    draft({ targetProvider: "  " }),
    draft({ targetFamily: "\n" }),
  ];
  assert.deepEqual(buildModelBudgetRulesSavePayload(rows), { rules: [] });
});

test("leading/trailing whitespace on otherwise-valid fields is trimmed in the saved payload", () => {
  const payload = buildModelBudgetRulesSavePayload([
    draft({ sourceProvider: " cc ", sourceFamily: " claude-opus-* " }),
  ]);
  assert.equal(payload.rules.length, 1);
  assert.equal(payload.rules[0].sourceProvider, "cc");
  assert.equal(payload.rules[0].sourceFamily, "claude-opus-*");
});

// ─── fix round 1 (review, Finding 1 — Critical): resolveModelBudgetRulesSave is the
// single gate that must stop a PUT { rules: [] } from being sent for any reason other
// than the admin genuinely clearing a *successfully loaded* rule list. ──────────────

test("status 'loading' never authorizes a save, even with a fully valid, non-empty draft list", () => {
  const decision = resolveModelBudgetRulesSave("loading", [draft()]);
  assert.equal(decision.shouldSave, false);
  assert.equal(decision.payload, null);
});

test("status 'error' never authorizes a save, even with a fully valid, non-empty draft list", () => {
  const decision = resolveModelBudgetRulesSave("error", [draft()]);
  assert.equal(decision.shouldSave, false);
  assert.equal(decision.payload, null);
});

test("status 'loaded' with an empty draft list is the legitimate clear-all — it IS authorized", () => {
  const decision = resolveModelBudgetRulesSave("loaded", []);
  assert.equal(decision.shouldSave, true);
  assert.deepEqual(decision.payload, { rules: [] });
});

test("status 'loaded' with valid rules authorizes a save and shapes the same payload as buildModelBudgetRulesSavePayload", () => {
  const drafts = [draft()];
  const decision = resolveModelBudgetRulesSave("loaded", drafts);
  assert.equal(decision.shouldSave, true);
  assert.deepEqual(decision.payload, buildModelBudgetRulesSavePayload(drafts));
});

test("every non-'loaded' status is rejected (exhaustive over the type), 'loaded' is the only one that saves", () => {
  const statuses: ModelBudgetRulesLoadStatus[] = ["loading", "loaded", "error"];
  for (const status of statuses) {
    const decision = resolveModelBudgetRulesSave(status, [draft()]);
    assert.equal(decision.shouldSave, status === "loaded", `status=${status}`);
  }
});
