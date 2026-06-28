import test from "node:test";
import assert from "node:assert/strict";
import {
  parseApiKeyIds,
  parseCostRange,
  parseExplorerGroupBy,
} from "../../src/app/(dashboard)/dashboard/costs/costExplorerParams.ts";

test("parseCostRange accepts valid cost ranges", () => {
  for (const range of ["7d", "30d", "90d", "all"]) {
    assert.equal(parseCostRange(range), range);
  }
});

test("parseCostRange falls back to 30d for invalid values", () => {
  assert.equal(parseCostRange(null), "30d");
  assert.equal(parseCostRange(""), "30d");
  assert.equal(parseCostRange("1y"), "30d");
  assert.equal(parseCostRange("ALL"), "30d");
});

test("parseExplorerGroupBy accepts valid cost explorer groups", () => {
  for (const groupBy of ["provider", "model", "apiKey", "account", "serviceTier"]) {
    assert.equal(parseExplorerGroupBy(groupBy), groupBy);
  }
});

test("parseExplorerGroupBy falls back to provider for invalid values", () => {
  assert.equal(parseExplorerGroupBy(null), "provider");
  assert.equal(parseExplorerGroupBy(""), "provider");
  assert.equal(parseExplorerGroupBy("apikey"), "provider");
  assert.equal(parseExplorerGroupBy("__proto__"), "provider");
});

test("parseApiKeyIds trims blanks and de-duplicates ids", () => {
  assert.deepEqual(parseApiKeyIds(null), []);
  assert.deepEqual(parseApiKeyIds(",, ,"), []);
  assert.deepEqual(parseApiKeyIds("a, b ,a,c,b"), ["a", "b", "c"]);
});
