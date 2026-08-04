import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteModelBudgetRulesForApiKey,
  listAllModelBudgetRules,
  listModelBudgetRules,
  replaceModelBudgetRules,
} from "../../../src/lib/db/apiKeyModelBudgetRules.ts";

const RULE = {
  enabled: true,
  priority: 0,
  sourceProvider: "cc",
  sourceFamily: "claude-opus-*",
  weeklyLimitUsd: 100,
  targetProvider: "cc",
  targetFamily: "claude-sonnet-*",
};

test("replace persists rules and returns them with ids", () => {
  const saved = replaceModelBudgetRules("key-rules-1", [RULE]);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].id, "rule must get an id");
  assert.equal(saved[0].apiKeyId, "key-rules-1");
  assert.equal(saved[0].weeklyLimitUsd, 100);
});

test("replace is a full swap, not an append", () => {
  replaceModelBudgetRules("key-rules-2", [RULE]);
  replaceModelBudgetRules("key-rules-2", [
    { ...RULE, sourceFamily: "claude-sonnet-*", weeklyLimitUsd: 50 },
  ]);

  const rules = listModelBudgetRules("key-rules-2");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].sourceFamily, "claude-sonnet-*");
});

test("list returns only enabled rules, ordered by priority", () => {
  replaceModelBudgetRules("key-rules-3", [
    { ...RULE, priority: 5, sourceFamily: "claude-opus-*" },
    { ...RULE, priority: 1, sourceFamily: "claude-fable-*" },
    { ...RULE, priority: 0, sourceFamily: "claude-haiku-*", enabled: false },
  ]);

  const enabled = listModelBudgetRules("key-rules-3");
  assert.deepEqual(
    enabled.map((r) => r.sourceFamily),
    ["claude-fable-*", "claude-opus-*"]
  );
  assert.equal(listAllModelBudgetRules("key-rules-3").length, 3);
});

test("rules are scoped to their own key", () => {
  replaceModelBudgetRules("key-rules-4a", [RULE]);
  replaceModelBudgetRules("key-rules-4b", [RULE]);
  deleteModelBudgetRulesForApiKey("key-rules-4a");

  assert.equal(listModelBudgetRules("key-rules-4a").length, 0);
  assert.equal(listModelBudgetRules("key-rules-4b").length, 1);
});

test("a non-positive limit is rejected", () => {
  assert.throws(() => replaceModelBudgetRules("key-rules-5", [{ ...RULE, weeklyLimitUsd: 0 }]));
});
