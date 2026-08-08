import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteFamilyMultipliersForApiKey,
  listAllFamilyMultipliers,
  listFamilyMultipliers,
  MAX_FAMILY_MULTIPLIER,
  replaceFamilyMultipliers,
} from "../../../src/lib/db/apiKeyModelFamilyMultipliers.ts";

const RULE = {
  enabled: true,
  priority: 0,
  provider: "anthropic",
  familyGlob: "claude-opus-*",
  multiplier: 2,
};

test("replace persists rules and returns them with ids", () => {
  const saved = replaceFamilyMultipliers("mult-key-1", [RULE]);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].id, "rule must get an id");
  assert.equal(saved[0].apiKeyId, "mult-key-1");
  assert.equal(saved[0].multiplier, 2);
});

test("replace is a full swap, not an append", () => {
  replaceFamilyMultipliers("mult-key-2", [RULE]);
  replaceFamilyMultipliers("mult-key-2", [
    { ...RULE, familyGlob: "claude-sonnet-*", multiplier: 3 },
  ]);

  const rules = listFamilyMultipliers("mult-key-2");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].familyGlob, "claude-sonnet-*");
  assert.equal(rules[0].multiplier, 3);
});

test("list returns only enabled rules, ordered by priority", () => {
  replaceFamilyMultipliers("mult-key-3", [
    { ...RULE, priority: 5, familyGlob: "claude-opus-*" },
    { ...RULE, priority: 1, familyGlob: "claude-fable-*" },
    { ...RULE, priority: 0, familyGlob: "claude-haiku-*", enabled: false },
  ]);

  const enabled = listFamilyMultipliers("mult-key-3");
  assert.deepEqual(
    enabled.map((r) => r.familyGlob),
    ["claude-fable-*", "claude-opus-*"]
  );
  assert.equal(listAllFamilyMultipliers("mult-key-3").length, 3);
});

test("rules are scoped to their own key", () => {
  replaceFamilyMultipliers("mult-key-4a", [RULE]);
  replaceFamilyMultipliers("mult-key-4b", [RULE]);
  deleteFamilyMultipliersForApiKey("mult-key-4a");

  assert.equal(listFamilyMultipliers("mult-key-4a").length, 0);
  assert.equal(listFamilyMultipliers("mult-key-4b").length, 1);
});

test("a non-positive multiplier is rejected", () => {
  assert.throws(() => replaceFamilyMultipliers("mult-key-5", [{ ...RULE, multiplier: 0 }]));
  assert.throws(() => replaceFamilyMultipliers("mult-key-5", [{ ...RULE, multiplier: -1 }]));
});

test("a multiplier above MAX_FAMILY_MULTIPLIER is rejected (the fat-finger 150-instead-of-1.50 guard)", () => {
  assert.throws(
    () => replaceFamilyMultipliers("mult-key-6", [{ ...RULE, multiplier: 150 }]),
    /20 or less/
  );
  // Exactly at the cap is allowed.
  const saved = replaceFamilyMultipliers("mult-key-6", [
    { ...RULE, multiplier: MAX_FAMILY_MULTIPLIER },
  ]);
  assert.equal(saved[0].multiplier, MAX_FAMILY_MULTIPLIER);
});

test("a full swap rejects the WHOLE batch (no partial write) when one row is invalid", () => {
  replaceFamilyMultipliers("mult-key-7", [RULE]);
  assert.throws(() =>
    replaceFamilyMultipliers("mult-key-7", [
      RULE,
      { ...RULE, familyGlob: "claude-sonnet-*", multiplier: -1 },
    ])
  );
  // The original rule set from before the failed replace must still be intact —
  // validation runs before the transaction opens, so a bad row never gets the chance
  // to delete the old rows first.
  const rules = listFamilyMultipliers("mult-key-7");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].familyGlob, "claude-opus-*");
});

test("an empty rules array clears a key's multipliers", () => {
  replaceFamilyMultipliers("mult-key-8", [RULE]);
  replaceFamilyMultipliers("mult-key-8", []);
  assert.equal(listFamilyMultipliers("mult-key-8").length, 0);
});
