import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeFamilyMultipliersPayload } from "../../../src/app/api/keys/[id]/family-multipliers/route.ts";

// ─── pure validation tests ──────────────────────────────────────────────────

test("a well-formed payload normalizes to rule inputs", () => {
  const rules = normalizeFamilyMultipliersPayload({
    rules: [
      {
        enabled: true,
        priority: 2,
        provider: "anthropic",
        familyGlob: "claude-opus-*",
        multiplier: "2",
      },
    ],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].multiplier, 2);
  assert.equal(rules[0].priority, 2);
});

test("a comma-decimal multiplier normalizes to its dot-decimal number (pt-BR keyboard)", () => {
  const rules = normalizeFamilyMultipliersPayload({
    rules: [
      {
        provider: "anthropic",
        familyGlob: "claude-sonnet-*",
        multiplier: "1,5",
      },
    ],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].multiplier, 1.5);
});

test("a missing rules array is rejected", () => {
  assert.throws(() => normalizeFamilyMultipliersPayload({}));
  assert.throws(() => normalizeFamilyMultipliersPayload({ rules: "nope" }));
});

test("a non-positive multiplier is rejected", () => {
  assert.throws(() =>
    normalizeFamilyMultipliersPayload({
      rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: 0 }],
    })
  );
  assert.throws(() =>
    normalizeFamilyMultipliersPayload({
      rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: -1 }],
    })
  );
});

test("a multiplier above the cap is rejected (150 instead of 1.50)", () => {
  assert.throws(
    () =>
      normalizeFamilyMultipliersPayload({
        rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: 150 }],
      }),
    /20 or less/
  );
});

test("an unparseable multiplier string is rejected, not silently coerced to NaN/0", () => {
  assert.throws(() =>
    normalizeFamilyMultipliersPayload({
      rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: "not-a-number" }],
    })
  );
});

test("an empty rules array clears the key's rules", () => {
  assert.deepEqual(normalizeFamilyMultipliersPayload({ rules: [] }), []);
});

// ─── route-contract tests: real Request objects against the actual route
// handlers, isolation pattern mirrors tests/unit/api/budget-rules-route.test.ts. ──

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-family-multipliers-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "family-multipliers-route-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { makeManagementSessionRequest } = await import("../../helpers/managementSession.ts");
const familyMultipliersRoute =
  await import("../../../src/app/api/keys/[id]/family-multipliers/route.ts");

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

describe("GET/PUT /api/keys/:id/family-multipliers", () => {
  test("GET rejects an unauthenticated request with 401", async () => {
    await settingsDb.updateSettings({ requireLogin: true, setupComplete: true });
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-01");

    const res = await familyMultipliersRoute.GET(
      new Request(`http://localhost/api/keys/${created.id}/family-multipliers`),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 401);
  });

  test("GET returns 404 for an unknown key id", async () => {
    const res = await familyMultipliersRoute.GET(
      await makeManagementSessionRequest(
        "http://localhost/api/keys/does-not-exist/family-multipliers"
      ),
      { params: Promise.resolve({ id: "does-not-exist" }) }
    );
    assert.equal(res.status, 404);
  });

  test("GET returns an empty rules array for a fresh key", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-02");

    const res = await familyMultipliersRoute.GET(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rules: unknown[] };
    assert.deepEqual(body.rules, []);
  });

  test("PUT persists rules and GET reflects them back", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-03");

    const putRes = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: {
            rules: [
              {
                enabled: true,
                priority: 1,
                provider: "anthropic",
                familyGlob: "claude-opus-*",
                multiplier: 2,
              },
            ],
          },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as {
      rules: Array<{ id: string; apiKeyId: string; multiplier: number }>;
    };
    assert.equal(putBody.rules.length, 1);
    assert.equal(putBody.rules[0].apiKeyId, created.id);
    assert.equal(putBody.rules[0].multiplier, 2);

    const getRes = await familyMultipliersRoute.GET(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    const getBody = (await getRes.json()) as { rules: unknown[] };
    assert.equal(getBody.rules.length, 1);
  });

  test("PUT accepts a comma-decimal multiplier end to end", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-03b");

    const putRes = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: {
            rules: [{ provider: "anthropic", familyGlob: "claude-sonnet-*", multiplier: "1,5" }],
          },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(putRes.status, 200);
    const body = (await putRes.json()) as { rules: Array<{ multiplier: number }> };
    assert.equal(body.rules[0].multiplier, 1.5);
  });

  test("PUT with an empty rules array clears existing rules (not an error)", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-04");

    await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: {
            rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: 2 }],
          },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );

    const clearRes = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: { rules: [] },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(clearRes.status, 200);
    const body = (await clearRes.json()) as { rules: unknown[] };
    assert.deepEqual(body.rules, []);
  });

  test("PUT returns 400 with a useful message for an invalid payload", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-05");

    const res = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: { rules: "nope" },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /rules must be an array/);
  });

  test("PUT returns 400, not 500, for an out-of-range multiplier (the storage-layer cap must not surface as a 500)", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-05b");

    const res = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: {
            rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: 150 }],
          },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /20 or less/);
  });

  test("PUT rejects an unauthenticated request with 401", async () => {
    await settingsDb.updateSettings({ requireLogin: true, setupComplete: true });
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-06");

    const res = await familyMultipliersRoute.PUT(
      new Request(`http://localhost/api/keys/${created.id}/family-multipliers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: [] }),
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 401);
  });

  // Fix-round pattern mirrored from budget-rules-route.test.ts: close the real cached
  // better-sqlite3 handle directly so the next query throws a genuine "database
  // connection is not open" error, exercising the controlled-500 path.
  test("GET returns a controlled 500 (not an unhandled throw) on a DB failure", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-07");
    core.getDbInstance().close();

    const res = await familyMultipliersRoute.GET(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);
  });

  test("PUT returns a controlled 500 (not an unhandled throw) on a DB failure", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-08");
    core.getDbInstance().close();

    const res = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: {
            rules: [{ provider: "anthropic", familyGlob: "claude-opus-*", multiplier: 2 }],
          },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);
  });

  test("PUT still returns 400 (not 500) for an invalid payload even though the rules table is untouched", async () => {
    const created = await apiKeysDb.createApiKey("Multiplier Key", "machine-mult-09");

    const res = await familyMultipliersRoute.PUT(
      await makeManagementSessionRequest(
        `http://localhost/api/keys/${created.id}/family-multipliers`,
        {
          method: "PUT",
          body: { rules: [{ multiplier: 0 }] },
        }
      ),
      { params: Promise.resolve({ id: created.id }) }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /multiplier must be a positive number/);
  });

  test("GET still returns 404 (not 500) for an unknown key id even with a healthy rules table", async () => {
    const res = await familyMultipliersRoute.GET(
      await makeManagementSessionRequest(
        "http://localhost/api/keys/still-unknown/family-multipliers"
      ),
      { params: Promise.resolve({ id: "still-unknown" }) }
    );
    assert.equal(res.status, 404);
  });
});
