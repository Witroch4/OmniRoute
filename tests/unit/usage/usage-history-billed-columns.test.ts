import test from "node:test";
import assert from "node:assert/strict";

import { getDbInstance } from "../../../src/lib/db/core.ts";
import { saveRequestUsage } from "../../../src/lib/usage/usageHistory.ts";

test("saveRequestUsage persists the billed pair when the request was redirected", async () => {
  await saveRequestUsage({
    provider: "cc",
    model: "claude-sonnet-5",
    billedProvider: "cc",
    billedModel: "claude-opus-4-8",
    apiKeyId: "key-billed-1",
    tokens: { input: 10, output: 5 },
    success: true,
    timestamp: "2026-08-02T00:00:00.000Z",
  });

  const row = getDbInstance()
    .prepare(
      "SELECT provider, model, billed_provider, billed_model FROM usage_history WHERE api_key_id = ?"
    )
    .get("key-billed-1") as Record<string, unknown>;

  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(row.billed_model, "claude-opus-4-8");
  assert.equal(row.billed_provider, "cc");
});

test("saveRequestUsage leaves the billed pair NULL when nothing was redirected", async () => {
  await saveRequestUsage({
    provider: "cc",
    model: "claude-sonnet-5",
    apiKeyId: "key-billed-2",
    tokens: { input: 10, output: 5 },
    success: true,
    timestamp: "2026-08-02T00:00:00.000Z",
  });

  const row = getDbInstance()
    .prepare("SELECT billed_provider, billed_model FROM usage_history WHERE api_key_id = ?")
    .get("key-billed-2") as Record<string, unknown>;

  assert.equal(row.billed_provider, null);
  assert.equal(row.billed_model, null);
});
