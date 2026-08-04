import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeBudgetRulesPayload } from "../../../src/app/api/keys/[id]/budget-rules/route.ts";

// ─── pure validation tests (Task 9 brief, Step 1) ──────────────────────────────

test("a well-formed payload normalizes to rule inputs", () => {
  const rules = normalizeBudgetRulesPayload({
    rules: [
      {
        enabled: true,
        priority: 2,
        sourceProvider: "cc",
        sourceFamily: "claude-opus-*",
        weeklyLimitUsd: "100",
        targetProvider: "cc",
        targetFamily: "claude-sonnet-*",
      },
    ],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].weeklyLimitUsd, 100);
  assert.equal(rules[0].priority, 2);
});

test("a missing rules array is rejected", () => {
  assert.throws(() => normalizeBudgetRulesPayload({}));
  assert.throws(() => normalizeBudgetRulesPayload({ rules: "nope" }));
});

test("a non-positive limit is rejected", () => {
  assert.throws(() =>
    normalizeBudgetRulesPayload({
      rules: [
        {
          sourceProvider: "cc",
          sourceFamily: "claude-opus-*",
          weeklyLimitUsd: 0,
          targetProvider: "cc",
          targetFamily: "claude-sonnet-*",
        },
      ],
    })
  );
});

test("an empty rules array clears the key's rules", () => {
  assert.deepEqual(normalizeBudgetRulesPayload({ rules: [] }), []);
});

// ─── route-contract tests: import the actual route handlers, invoke them with
// real Request objects + the Next.js `{ params: Promise<{ id }> }` shape, and
// exercise auth + persistence end to end (isolation pattern mirrors
// tests/unit/api/free-proxies-route.test.ts and compression-engines-route.test.ts). ──

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-budget-rules-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budget-rules-route-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { makeManagementSessionRequest } = await import("../../helpers/managementSession.ts");
const budgetRulesRoute = await import("../../../src/app/api/keys/[id]/budget-rules/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR;
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("GET/PUT /api/keys/:id/budget-rules", () => {
  test("GET rejects an unauthenticated request with 401", async () => {
    await settingsDb.updateSettings({ requireLogin: true, setupComplete: true });
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-01");

    const res = await budgetRulesRoute.GET(
      new Request(`http://localhost/api/keys/${created.id}/budget-rules`),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 401);
  });

  test("GET returns 404 for an unknown key id", async () => {
    const res = await budgetRulesRoute.GET(
      await makeManagementSessionRequest("http://localhost/api/keys/does-not-exist/budget-rules"),
      { params: Promise.resolve({ id: "does-not-exist" }) }
    );
    assert.equal(res.status, 404);
  });

  test("GET returns an empty rules array for a fresh key", async () => {
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-02");

    const res = await budgetRulesRoute.GET(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rules: unknown[] };
    assert.deepEqual(body.rules, []);
  });

  test("PUT persists rules and GET reflects them back", async () => {
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-03");

    const putRes = await budgetRulesRoute.PUT(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        body: {
          rules: [
            {
              enabled: true,
              priority: 1,
              sourceProvider: "cc",
              sourceFamily: "claude-opus-*",
              weeklyLimitUsd: 50,
              targetProvider: "cc",
              targetFamily: "claude-sonnet-*",
            },
          ],
        },
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as {
      rules: Array<{ id: string; apiKeyId: string; weeklyLimitUsd: number }>;
    };
    assert.equal(putBody.rules.length, 1);
    assert.equal(putBody.rules[0].apiKeyId, created.id);
    assert.equal(putBody.rules[0].weeklyLimitUsd, 50);

    const getRes = await budgetRulesRoute.GET(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`),
      { params: Promise.resolve({ id: created.id }) }
    );
    const getBody = (await getRes.json()) as { rules: unknown[] };
    assert.equal(getBody.rules.length, 1);
  });

  test("PUT with an empty rules array clears existing rules (not an error)", async () => {
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-04");

    await budgetRulesRoute.PUT(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        body: {
          rules: [
            {
              sourceProvider: "cc",
              sourceFamily: "claude-opus-*",
              weeklyLimitUsd: 50,
              targetProvider: "cc",
              targetFamily: "claude-sonnet-*",
            },
          ],
        },
      }),
      { params: Promise.resolve({ id: created.id }) }
    );

    const clearRes = await budgetRulesRoute.PUT(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        body: { rules: [] },
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(clearRes.status, 200);
    const body = (await clearRes.json()) as { rules: unknown[] };
    assert.deepEqual(body.rules, []);
  });

  test("PUT returns 400 with a useful message for an invalid payload", async () => {
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-05");

    const res = await budgetRulesRoute.PUT(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        body: { rules: "nope" },
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /rules must be an array/);
  });

  test("PUT rejects an unauthenticated request with 401", async () => {
    await settingsDb.updateSettings({ requireLogin: true, setupComplete: true });
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-06");

    const res = await budgetRulesRoute.PUT(
      new Request(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: [] }),
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 401);
  });

  // ─── fix round 1: unexpected DB failures must return a controlled 500, not an
  // unhandled throw. Injection seam: close the real `better-sqlite3` handle
  // underneath the shared `getDbInstance()` singleton directly — bypass
  // `core.resetDbInstance()`'s cleanup (which nulls the cached reference and
  // would just make the next `getDbInstance()` call transparently reopen a
  // fresh connection) so the *same* cached, now-closed handle is still
  // returned to the route, and the next query against it throws a genuine
  // "database connection is not open" error. No module mocking — ESM named
  // exports here are live bindings and can't be reassigned from a test file.
  //
  // An earlier version of this seam used `DROP TABLE api_key_model_budget_rules`
  // instead. That reproducibly failed only the PUT case, and only when run as
  // part of the full suite (passed in isolation) — some side effect of the DDL
  // statement outlived the test and surfaced as an unhandled SQLITE_ERROR
  // attributed to the next test. Closing the connection directly is a purely
  // synchronous, local fault with no such cross-test leakage (3/3 clean full-
  // suite runs after the switch, vs. a reproducible failure before). The
  // `test.beforeEach` reset (`core.resetDbInstance()` + fresh `DATA_DIR`)
  // still fully recovers before the next test either way. ───────────────────

  test("GET returns a controlled 500 (not an unhandled throw) on a DB failure", async () => {
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-07");
    core.getDbInstance().close();

    const res = await budgetRulesRoute.GET(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);
  });

  test("PUT returns a controlled 500 (not an unhandled throw) on a DB failure", async () => {
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-08");
    core.getDbInstance().close();

    const res = await budgetRulesRoute.PUT(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        body: {
          rules: [
            {
              sourceProvider: "cc",
              sourceFamily: "claude-opus-*",
              weeklyLimitUsd: 50,
              targetProvider: "cc",
              targetFamily: "claude-sonnet-*",
            },
          ],
        },
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);
  });

  test("PUT still returns 400 (not 500) for an invalid payload even though the rules table is untouched", async () => {
    // Guards the ordering fix: the outer try/catch must not swallow the
    // validation 400 into a 500. No table manipulation here — this is the
    // regression the "be deliberate about ordering" warning was about.
    const created = await apiKeysDb.createApiKey("Budget Rules Key", "machine-budget-09");

    const res = await budgetRulesRoute.PUT(
      await makeManagementSessionRequest(`http://localhost/api/keys/${created.id}/budget-rules`, {
        method: "PUT",
        body: { rules: [{ weeklyLimitUsd: 0 }] },
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /weeklyLimitUsd must be a positive number/);
  });

  test("GET still returns 404 (not 500) for an unknown key id even with a healthy rules table", async () => {
    const res = await budgetRulesRoute.GET(
      await makeManagementSessionRequest("http://localhost/api/keys/still-unknown/budget-rules"),
      { params: Promise.resolve({ id: "still-unknown" }) }
    );
    assert.equal(res.status, 404);
  });
});
