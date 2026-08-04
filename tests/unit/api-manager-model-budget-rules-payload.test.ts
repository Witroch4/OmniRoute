import test from "node:test";
import assert from "node:assert/strict";

import { buildModelBudgetRulesSavePayload } from "../../src/app/(dashboard)/dashboard/api-manager/modelBudgetRulesPayload.ts";
import type { ModelBudgetRuleDraft } from "../../src/app/(dashboard)/dashboard/api-manager/components/ModelBudgetRoutingSettings.tsx";

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
