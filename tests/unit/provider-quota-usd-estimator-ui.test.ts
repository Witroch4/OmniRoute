import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits";
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, base, rel), "utf8");

const expanded = read("parts/QuotaCardExpanded.tsx");
const card = read("QuotaCard.tsx");
const grid = read("QuotaCardGrid.tsx");
const index = read("index.tsx");
const modal = read("QuotaUsdEstimateModal.tsx");

test("provider quota cards expose a per-account USD estimate action", () => {
  assert.match(expanded, /onOpenUsdEstimate:\s*\(\)\s*=>\s*void/);
  assert.match(expanded, /canEstimateUsd:\s*boolean/);
  assert.match(expanded, /quotaUsdShort/);
  assert.match(expanded, />calculate</);
  assert.match(card, /usdEstimate\?: any \| null/);
  assert.match(card, /onOpenUsdEstimate=\{onOpenUsdEstimate\}/);
  assert.match(grid, /onOpenUsdEstimate:\s*\(connection: any\)\s*=>\s*void/);
  assert.match(grid, /onOpenUsdEstimate\(conn\)/);
});

test("ProviderLimits wires the USD estimate modal to cached and live quota payloads", () => {
  assert.match(index, /import QuotaUsdEstimateModal/);
  assert.match(index, /usdEstimate: cached\.usdEstimate \|\| null/);
  assert.match(index, /usdEstimate: data\.usdEstimate \|\| null/);
  assert.match(index, /setUsdEstimateModalConn\(conn\)/);
  assert.match(index, /<QuotaUsdEstimateModal/);
});

test("QuotaUsdEstimateModal contains a 0-100 percent slider and estimate readout", () => {
  assert.match(modal, /useState\(25\)/);
  assert.match(modal, /type="range"/);
  assert.match(modal, /min="0"/);
  assert.match(modal, /max="100"/);
  assert.match(modal, /quotaUsdPercentSlider/);
  assert.match(modal, /quotaUsdSelectedValue/);
  assert.match(modal, /estimatedUsdPerPercent \* targetPercent/);
});

test("USD estimate i18n keys exist in en and pt-BR", () => {
  for (const locale of ["en", "pt-BR"]) {
    const msgs = JSON.parse(
      fs.readFileSync(path.join(repoRoot, `src/i18n/messages/${locale}.json`), "utf8")
    );
    for (const key of [
      "quotaUsdEstimate",
      "quotaUsdShort",
      "quotaUsdPercentSlider",
      "quotaUsdSelectedValue",
      "quotaUsdFullEstimate",
      "quotaUsdConfidenceUnavailable",
    ]) {
      assert.ok(msgs.usage?.[key], `${locale}: usage.${key} must exist`);
    }
  }
});
