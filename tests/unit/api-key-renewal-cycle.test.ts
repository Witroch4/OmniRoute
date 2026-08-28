import test from "node:test";
import assert from "node:assert/strict";

import {
  addMonthsKeepingAnchorDay,
  computeNextRenewalCutoff,
  cycleOwnsExpiry,
  daysUntilCutoff,
  normalizeRenewalCycleMonths,
} from "../../src/shared/utils/apiKeyRenewalCycle.ts";
import { resolveRenewalCycleExpiry } from "../../src/lib/db/apiKeyRenewalCycleFields.ts";

const ANCHOR = "2026-08-27T03:00:00.000Z";

// ─────────────────────────── period normalization ───────────────────────────

test("months normalize to a sane whole period", () => {
  assert.equal(normalizeRenewalCycleMonths(1), 1);
  assert.equal(normalizeRenewalCycleMonths(3), 3);
  assert.equal(normalizeRenewalCycleMonths("6"), 6);
  assert.equal(normalizeRenewalCycleMonths(2.7), 2);
  // Absent / nonsense / out-of-range never yields 0 — a 0-month period would make the
  // occurrence walk spin on the same instant forever.
  assert.equal(normalizeRenewalCycleMonths(0), 1);
  assert.equal(normalizeRenewalCycleMonths(-5), 1);
  assert.equal(normalizeRenewalCycleMonths(undefined), 1);
  assert.equal(normalizeRenewalCycleMonths(Number.NaN), 1);
  assert.equal(normalizeRenewalCycleMonths(9999), 60);
});

// ─────────────────────────── anchor-day arithmetic ──────────────────────────

test("month addition keeps the anchor day and clamps short months without drifting", () => {
  const jan31 = Date.parse("2026-01-31T12:00:00.000Z");

  // Feb has no 31st: clamp. March does: the anchor day comes BACK. This is the whole
  // point of clamping from the original anchor instead of from the clamped result.
  assert.equal(
    new Date(addMonthsKeepingAnchorDay(jan31, 1)).toISOString(),
    "2026-02-28T12:00:00.000Z"
  );
  assert.equal(
    new Date(addMonthsKeepingAnchorDay(jan31, 2)).toISOString(),
    "2026-03-31T12:00:00.000Z"
  );
  assert.equal(
    new Date(addMonthsKeepingAnchorDay(jan31, 3)).toISOString(),
    "2026-04-30T12:00:00.000Z"
  );
});

test("month addition handles a leap February and rolls the year", () => {
  // 2028 is a leap year, 2027 is not: the same anchor day clamps differently.
  const leapJan31 = Date.parse("2028-01-31T09:15:00.000Z");
  assert.equal(
    new Date(addMonthsKeepingAnchorDay(leapJan31, 1)).toISOString(),
    "2028-02-29T09:15:00.000Z"
  );
  const commonJan31 = Date.parse("2027-01-31T09:15:00.000Z");
  assert.equal(
    new Date(addMonthsKeepingAnchorDay(commonJan31, 1)).toISOString(),
    "2027-02-28T09:15:00.000Z"
  );
  assert.equal(
    new Date(addMonthsKeepingAnchorDay(commonJan31, 12)).toISOString(),
    "2028-01-31T09:15:00.000Z"
  );
});

// ─────────────────────────── next-cutoff resolution ─────────────────────────

test("the cutoff is the next anchor day, not the day the cycle was configured", () => {
  // Witalo's case: base date is today (27 Aug), so the key must run until 27 Sep — a
  // cycle configured on its own anchor day must not kill the key the same day.
  const now = Date.parse("2026-08-27T14:00:00.000Z");
  assert.equal(computeNextRenewalCutoff(ANCHOR, 1, now), "2026-09-27T03:00:00.000Z");
});

test("an anchor in the future is itself the first cutoff", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  assert.equal(computeNextRenewalCutoff(ANCHOR, 1, now), ANCHOR);
});

test("renewing late keeps the same day-of-month instead of drifting", () => {
  // Lapsed on 27 Sep, paid on 2 Oct: the client loses the 5 late days, but the cycle
  // still renews on the 27th — an "add 30 days" scheme would have moved it to the 2nd.
  const paidLate = Date.parse("2026-10-02T18:30:00.000Z");
  assert.equal(computeNextRenewalCutoff(ANCHOR, 1, paidLate), "2026-10-27T03:00:00.000Z");
});

test("a cutoff exactly at now rolls to the following occurrence", () => {
  // Strictly-after: renewing at the instant of the cutoff must buy a full period, not
  // resolve to the moment that just elapsed.
  const now = Date.parse("2026-09-27T03:00:00.000Z");
  assert.equal(computeNextRenewalCutoff(ANCHOR, 1, now), "2026-10-27T03:00:00.000Z");
});

test("multi-month periods land on period boundaries only", () => {
  const now = Date.parse("2026-10-15T00:00:00.000Z");
  // Quarterly from 27 Aug: 27 Nov, never the 27 Sep/Oct in between.
  assert.equal(computeNextRenewalCutoff(ANCHOR, 3, now), "2026-11-27T03:00:00.000Z");
  assert.equal(computeNextRenewalCutoff(ANCHOR, 12, now), "2027-08-27T03:00:00.000Z");
});

test("a long-abandoned anchor still resolves to the next future occurrence", () => {
  const now = Date.parse("2031-03-05T00:00:00.000Z");
  const cutoff = computeNextRenewalCutoff("2020-01-31T00:00:00.000Z", 1, now);
  assert.equal(cutoff, "2031-03-31T00:00:00.000Z");
});

test("an unusable anchor yields no cutoff instead of a garbage one", () => {
  const now = Date.parse("2026-08-27T14:00:00.000Z");
  for (const anchor of [null, undefined, "", "   ", "not-a-date"]) {
    assert.equal(computeNextRenewalCutoff(anchor, 1, now), null, `anchor=${String(anchor)}`);
  }
});

// ───────────────────────────── countdown display ────────────────────────────

test("days remaining round up while valid and down once lapsed", () => {
  const now = Date.parse("2026-08-27T14:00:00.000Z");
  assert.equal(daysUntilCutoff("2026-09-27T03:00:00.000Z", now), 31);
  // A few hours left is still "1 day", never "0 days" on a key that works.
  assert.equal(daysUntilCutoff("2026-08-27T20:00:00.000Z", now), 1);
  assert.equal(daysUntilCutoff("2026-08-26T14:00:00.000Z", now), -1);
  assert.equal(daysUntilCutoff(null, now), null);
});

// ─────────────────────────── expires_at ownership ───────────────────────────

const NOW = Date.parse("2026-08-27T14:00:00.000Z");

test("the cycle only owns the expiry once it is enabled AND anchored", () => {
  assert.equal(cycleOwnsExpiry({ renewalCycleEnabled: true, renewalCycleAnchorAt: ANCHOR }), true);
  assert.equal(
    cycleOwnsExpiry({ renewalCycleEnabled: false, renewalCycleAnchorAt: ANCHOR }),
    false
  );
  assert.equal(cycleOwnsExpiry({ renewalCycleEnabled: true, renewalCycleAnchorAt: null }), false);
});

test("enabling the cycle writes the first cutoff", () => {
  const decision = resolveRenewalCycleExpiry(
    { renewalCycleEnabled: false, expiresAt: null },
    { renewalCycleEnabled: true, renewalCycleAnchorAt: ANCHOR, renewalCycleMonths: 1 },
    NOW
  );
  assert.deepEqual(decision, { action: "set", expiresAt: "2026-09-27T03:00:00.000Z" });
});

test("an unrelated edit never buys another period", () => {
  // The regression this guards: renaming a lapsed key silently renewing it. The saved
  // form round-trips the cycle fields unchanged, so "unchanged" must mean "don't move".
  const lapsed = {
    renewalCycleEnabled: true,
    renewalCycleAnchorAt: ANCHOR,
    renewalCycleMonths: 1,
    expiresAt: "2026-08-27T03:00:00.000Z",
  };
  const decision = resolveRenewalCycleExpiry(
    lapsed,
    {
      renewalCycleEnabled: true,
      renewalCycleAnchorAt: ANCHOR,
      renewalCycleMonths: 1,
    },
    Date.parse("2026-09-10T00:00:00.000Z")
  );
  assert.deepEqual(decision, { action: "freeze" });
});

test("saving twice cannot stack periods", () => {
  const state = {
    renewalCycleEnabled: true,
    renewalCycleAnchorAt: ANCHOR,
    renewalCycleMonths: 1,
    expiresAt: "2026-09-27T03:00:00.000Z",
  };
  const first = resolveRenewalCycleExpiry(state, { renewRenewalCycle: true }, NOW);
  assert.deepEqual(first, { action: "set", expiresAt: "2026-09-27T03:00:00.000Z" });

  const second = resolveRenewalCycleExpiry(state, {}, NOW);
  assert.deepEqual(second, { action: "freeze" });
});

test("renew advances a lapsed key to the next anchor day", () => {
  const decision = resolveRenewalCycleExpiry(
    {
      renewalCycleEnabled: true,
      renewalCycleAnchorAt: ANCHOR,
      renewalCycleMonths: 1,
      expiresAt: "2026-09-27T03:00:00.000Z",
    },
    { renewRenewalCycle: true },
    Date.parse("2026-09-30T12:00:00.000Z")
  );
  assert.deepEqual(decision, { action: "set", expiresAt: "2026-10-27T03:00:00.000Z" });
});

test("changing the base date or the period recomputes immediately", () => {
  const state = {
    renewalCycleEnabled: true,
    renewalCycleAnchorAt: ANCHOR,
    renewalCycleMonths: 1,
    expiresAt: "2026-09-27T03:00:00.000Z",
  };
  assert.deepEqual(
    resolveRenewalCycleExpiry(state, { renewalCycleAnchorAt: "2026-08-05T03:00:00.000Z" }, NOW),
    { action: "set", expiresAt: "2026-09-05T03:00:00.000Z" }
  );
  assert.deepEqual(resolveRenewalCycleExpiry(state, { renewalCycleMonths: 3 }, NOW), {
    action: "set",
    expiresAt: "2026-11-27T03:00:00.000Z",
  });
});

test("disabling the cycle releases the cutoff it had written", () => {
  const decision = resolveRenewalCycleExpiry(
    {
      renewalCycleEnabled: true,
      renewalCycleAnchorAt: ANCHOR,
      renewalCycleMonths: 1,
      expiresAt: "2026-09-27T03:00:00.000Z",
    },
    { renewalCycleEnabled: false },
    NOW
  );
  assert.deepEqual(decision, { action: "clear" });
});

test("keys without a cycle keep the plain one-shot expiry behaviour", () => {
  const decision = resolveRenewalCycleExpiry(
    { renewalCycleEnabled: false, expiresAt: "2026-12-01T00:00:00.000Z" },
    {},
    NOW
  );
  assert.deepEqual(decision, { action: "passthrough" });
});

test("enabling the toggle without a base date does not touch the expiry", () => {
  const decision = resolveRenewalCycleExpiry(
    { renewalCycleEnabled: false, expiresAt: "2026-12-01T00:00:00.000Z" },
    { renewalCycleEnabled: true },
    NOW
  );
  assert.deepEqual(decision, { action: "passthrough" });
});

test("a cycle whose cutoff went missing is re-materialized", () => {
  const decision = resolveRenewalCycleExpiry(
    {
      renewalCycleEnabled: true,
      renewalCycleAnchorAt: ANCHOR,
      renewalCycleMonths: 1,
      expiresAt: null,
    },
    {},
    NOW
  );
  assert.deepEqual(decision, { action: "set", expiresAt: "2026-09-27T03:00:00.000Z" });
});
