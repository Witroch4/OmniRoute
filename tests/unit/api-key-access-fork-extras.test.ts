/**
 * Fork-only settings of the full-page API key access editor (renewal cycle, min-spend
 * guarantee). They used to live in the API Manager's PermissionsModal, which upstream
 * replaced with /dashboard/api-manager/[id]/access. The editor sends them on the same
 * PATCH, but ONLY when edited: an untouched editor must send exactly upstream's body
 * (pinned by api-key-access-form.test.ts), and the route treats an absent field as
 * "unchanged".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForkFieldsPatch,
  createInitialForkFieldsState,
} from "@/app/(dashboard)/dashboard/api-manager/[id]/access/useApiKeyForkExtras";

const storedKey = {
  id: "k1",
  minSpendGuaranteeEnabled: true,
  minSpendGuaranteeUsd: 40,
  renewalCycleEnabled: true,
  renewalCycleAnchorAt: "2026-10-27T03:00:00.000Z",
  renewalCycleMonths: 1,
};

test("initial state mirrors the stored fork columns", () => {
  assert.deepEqual(createInitialForkFieldsState(storedKey), {
    minSpendGuaranteeEnabled: true,
    minSpendGuaranteeUsd: "40",
    renewalCycle: {
      enabled: true,
      anchorAt: "2026-10-27T03:00:00.000Z",
      months: 1,
      renewNow: false,
    },
  });
  const empty = createInitialForkFieldsState({ id: "k2", minSpendGuaranteeUsd: -1 });
  assert.equal(empty.minSpendGuaranteeEnabled, false);
  assert.equal(empty.minSpendGuaranteeUsd, "");
  assert.equal(empty.renewalCycle.enabled, false);
});

test("an untouched editor adds nothing to the PATCH body", () => {
  const initial = createInitialForkFieldsState(storedKey);
  assert.deepEqual(buildForkFieldsPatch(initial, initial), {});
});

test("editing the min-spend guarantee sends both of its fields, nothing else", () => {
  const initial = createInitialForkFieldsState(storedKey);
  const edited = { ...initial, minSpendGuaranteeUsd: "55.5" };
  assert.deepEqual(buildForkFieldsPatch(edited, initial), {
    minSpendGuaranteeEnabled: true,
    minSpendGuaranteeUsd: 55.5,
  });
  const cleared = { ...initial, minSpendGuaranteeUsd: "" };
  assert.deepEqual(buildForkFieldsPatch(cleared, initial), {
    minSpendGuaranteeEnabled: true,
    minSpendGuaranteeUsd: null,
  });
});

test("renewing the cycle sends the whole cycle group with renewRenewalCycle", () => {
  const initial = createInitialForkFieldsState(storedKey);
  const renewed = { ...initial, renewalCycle: { ...initial.renewalCycle, renewNow: true } };
  assert.deepEqual(buildForkFieldsPatch(renewed, initial), {
    renewalCycleEnabled: true,
    renewalCycleAnchorAt: "2026-10-27T03:00:00.000Z",
    renewalCycleMonths: 1,
    renewRenewalCycle: true,
  });
});
