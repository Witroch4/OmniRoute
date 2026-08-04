import test from "node:test";
import assert from "node:assert/strict";

import { getDbInstance } from "../../../src/lib/db/core.ts";
import {
  getApiKeyFamilyRealSpendSince,
  getApiKeyUsdSpendSince,
} from "../../../src/lib/usage/apiKeyUsageLimits.ts";

const SINCE = "2026-08-01T00:00:00.000Z";

function insertRow(row: {
  apiKeyId: string;
  provider: string;
  model: string;
  billedProvider?: string | null;
  billedModel?: string | null;
  input: number;
  output: number;
}) {
  getDbInstance()
    .prepare(
      `INSERT INTO usage_history
         (provider, model, billed_provider, billed_model, api_key_id,
          tokens_input, tokens_output, service_tier, success, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'standard', 1, ?)`
    )
    .run(
      row.provider,
      row.model,
      row.billedProvider ?? null,
      row.billedModel ?? null,
      row.apiKeyId,
      row.input,
      row.output,
      "2026-08-02T00:00:00.000Z"
    );
}

test("normalized and real agree when nothing was redirected", async () => {
  const apiKeyId = "key-basis-plain";
  insertRow({ apiKeyId, provider: "cc", model: "claude-sonnet-5", input: 1_000_000, output: 0 });

  const normalized = await getApiKeyUsdSpendSince(apiKeyId, SINCE);
  const real = await getApiKeyUsdSpendSince(apiKeyId, SINCE, { basis: "real" });

  assert.ok(normalized > 0, "sonnet traffic must price above zero");
  assert.equal(normalized, real);
});

test("a redirected row is billed at the requested model and served at the real one", async () => {
  const apiKeyId = "key-basis-redirected";
  insertRow({
    apiKeyId,
    provider: "cc",
    model: "claude-sonnet-5",
    billedProvider: "cc",
    billedModel: "claude-opus-4-8",
    input: 1_000_000,
    output: 0,
  });

  const normalized = await getApiKeyUsdSpendSince(apiKeyId, SINCE);
  const real = await getApiKeyUsdSpendSince(apiKeyId, SINCE, { basis: "real" });

  assert.ok(normalized > real, "opus rates must exceed sonnet rates for identical tokens");
});

test("family real spend only counts the model that actually ran", async () => {
  const apiKeyId = "key-basis-family";
  insertRow({
    apiKeyId,
    provider: "cc",
    model: "claude-sonnet-5",
    billedProvider: "cc",
    billedModel: "claude-opus-4-8",
    input: 1_000_000,
    output: 0,
  });

  const opus = await getApiKeyFamilyRealSpendSince(apiKeyId, "cc", "claude-opus-*", SINCE);
  const sonnet = await getApiKeyFamilyRealSpendSince(apiKeyId, "cc", "claude-sonnet-*", SINCE);

  assert.equal(opus, 0, "redirected traffic must not count toward the opus budget");
  assert.ok(sonnet > 0, "redirected traffic must count toward the sonnet budget");
});
