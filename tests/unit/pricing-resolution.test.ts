import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { getDefaultPricing } from "../../src/shared/constants/pricing";
import {
  getPricingModelCandidates,
  reportMissingPricing,
  resetMissingPricingReportsForTests,
  resolveModelPricing,
  stripEffortSuffix,
} from "../../src/lib/usage/pricingResolution";
import { computeCostFromPricing } from "../../src/lib/usage/costCalculator";

const CATALOG = getDefaultPricing() as Record<string, Record<string, Record<string, unknown>>>;

// One real day of `claude-opus-5` traffic on a single API key, taken from
// production `usage_history` (2026-07-31). This is the workload that exposed
// the bug: 854 requests billed as $0 by the cost modal and as $1.1k by the
// dashboard, when its true cost is ~$576.
const PROD_OPUS5_DAY = {
  input: 288_649_749,
  output: 571_388,
  cacheRead: 210_257_014,
  cacheCreation: 51_495_233,
};

describe("pricing resolution", () => {
  beforeEach(() => {
    resetMissingPricingReportsForTests();
  });

  describe("catalog coverage", () => {
    it("prices claude-opus-5 explicitly, at Opus tier rates", () => {
      const { pricing, source } = resolveModelPricing(CATALOG, "claude", "claude-opus-5");

      assert.equal(source, "exact", "claude-opus-5 must have its own catalog row");
      assert.deepEqual(
        {
          input: pricing?.input,
          output: pricing?.output,
          cached: pricing?.cached,
          cache_creation: pricing?.cache_creation,
        },
        { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25 }
      );
    });

    it("costs a real day of claude-opus-5 traffic at its true price", () => {
      const { pricing } = resolveModelPricing(CATALOG, "claude", "claude-opus-5");
      const cost = computeCostFromPricing(pricing, PROD_OPUS5_DAY, {
        provider: "claude",
        model: "claude-opus-5",
      });

      // ~$575.75. Before the fix this same input produced $0 (exact-lookup
      // path) or ~$1151 (dashboard path priced it as claude-fable-5).
      assert.ok(cost > 570 && cost < 582, `expected ~$576, got $${cost.toFixed(2)}`);
    });

    it("never prices an Opus model at Fable rates", () => {
      const opus = resolveModelPricing(CATALOG, "claude", "claude-opus-5").pricing;
      const fable = resolveModelPricing(CATALOG, "claude", "claude-fable-5").pricing;

      assert.notEqual(
        opus?.input,
        fable?.input,
        "Opus must not inherit Fable's $10/MTok input rate"
      );
      assert.equal(fable?.input, 10.0);
    });
  });

  describe("Claude family anchor", () => {
    it("prices an unknown Opus tier at Opus rates instead of $0", () => {
      const { pricing, source, matchedModel } = resolveModelPricing(
        CATALOG,
        "claude",
        "claude-opus-6"
      );

      assert.equal(source, "family_anchor");
      assert.equal(matchedModel, "claude-opus-4-8");
      assert.equal(pricing?.input, 5.0);
      assert.equal(pricing?.output, 25.0);
    });

    it("prices unknown Sonnet and Haiku tiers at their own rates", () => {
      const sonnet = resolveModelPricing(CATALOG, "claude", "claude-sonnet-6");
      assert.equal(sonnet.source, "family_anchor");
      assert.equal(sonnet.pricing?.input, 3.0);

      const haiku = resolveModelPricing(CATALOG, "claude", "claude-haiku-5");
      assert.equal(haiku.source, "family_anchor");
      assert.equal(haiku.pricing?.input, 1.0);
    });

    it("routes an unknown Fable tier to Fable rates, not Opus", () => {
      const { pricing, matchedModel } = resolveModelPricing(CATALOG, "claude", "claude-fable-6");

      assert.equal(matchedModel, "claude-fable-5");
      assert.equal(pricing?.input, 10.0, "Fable must not be priced at the Opus tier");
    });

    it("applies the anchor to Claude models served by other providers", () => {
      // amazon-q and github serve Claude ids but carry no Claude pricing rows.
      const { pricing, source } = resolveModelPricing(CATALOG, "amazon-q", "claude-opus-7");

      assert.ok(source === "family_anchor" || source === "cross_provider");
      assert.equal(pricing?.input, 5.0);
    });
  });

  describe("no silent mispricing for other providers", () => {
    it("returns missing for an uncataloged Gemini model", () => {
      const { pricing, source } = resolveModelPricing(CATALOG, "agy", "gemini-3.6-flash-high");

      assert.equal(source, "missing");
      assert.equal(pricing, null);
    });

    it("does not fall back to the provider's first catalog entry", () => {
      // The old dashboard chain ended at Object.keys(providerPricing)[0].
      const catalog = {
        cc: {
          "claude-fable-5": { input: 10.0, output: 50.0 },
          "claude-opus-4-8": { input: 5.0, output: 25.0 },
        },
      };
      const { pricing, source } = resolveModelPricing(catalog, "cc", "totally-unknown-model");

      assert.equal(source, "missing");
      assert.equal(pricing, null, "must not borrow the first entry's rates");
    });

    it("does not match a catalog key by substring", () => {
      const catalog = { openai: { "gpt-4.1": { input: 2.0, output: 8.0 } } };
      const { source } = resolveModelPricing(catalog, "openai", "gpt-4");

      assert.equal(source, "missing", "'gpt-4' must not silently borrow 'gpt-4.1' rates");
    });
  });

  describe("model and provider key matching", () => {
    it("resolves a model through its provider alias", () => {
      const viaId = resolveModelPricing(CATALOG, "codex", "gpt-5.5");
      const viaAlias = resolveModelPricing(CATALOG, "cx", "gpt-5.5");

      assert.ok(viaId.pricing, "provider id must resolve");
      assert.deepEqual(viaId.pricing, viaAlias.pricing);
    });

    it("strips a trailing effort suffix", () => {
      assert.equal(stripEffortSuffix("gpt-5.5-medium"), "gpt-5.5");
      assert.equal(stripEffortSuffix("gpt-5.6-sol-xhigh"), "gpt-5.6-sol");
      assert.equal(stripEffortSuffix("claude-opus-5"), "claude-opus-5");

      const { pricing } = resolveModelPricing(CATALOG, "codex", "gpt-5.5-medium");
      assert.ok(pricing, "effort-suffixed model must resolve to its base rates");
    });

    it("offers dot and hyphen spellings as candidates", () => {
      const candidates = getPricingModelCandidates("gemini-3.1-pro");
      assert.ok(candidates.includes("gemini-3.1-pro"));
      assert.ok(candidates.includes("gemini-3-1-pro"));
    });
  });

  describe("gap reporting", () => {
    it("warns once per pair for a missing model, and for anchor hits", () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message: string) => void warnings.push(message);

      try {
        reportMissingPricing("agy", "gemini-3.6-flash-high", "missing");
        reportMissingPricing("agy", "gemini-3.6-flash-high", "missing");
        reportMissingPricing("claude", "claude-opus-6", "family_anchor");
        reportMissingPricing("claude", "claude-opus-5", "exact");
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(warnings.length, 2, "one warning per unique pair, none for exact hits");
      assert.match(warnings[0], /no pricing row/);
      assert.match(warnings[0], /costed at \$0/);
      assert.match(warnings[1], /Claude tier rates/);
    });
  });
});

// A newly released Claude id lands in the catalog before anyone writes a pricing
// row for it. `claude-fable-5-1` is that case: it must bill at the FABLE tier via
// the family anchor, never at $0 and never at the Opus tier (Fable is priced
// above Opus, so falling into the looser claude rule would undercharge by half).
describe("claude-fable-5-1 (no explicit row yet)", () => {
  it("bills at the fable tier through the family anchor", () => {
    const resolved = resolveModelPricing(CATALOG, "claude", "claude-fable-5-1");
    const fable5 = resolveModelPricing(CATALOG, "claude", "claude-fable-5").pricing;

    assert.equal(resolved.source, "family_anchor");
    assert.ok(resolved.pricing, "must not resolve to missing/zero pricing");
    assert.deepEqual(
      resolved.pricing,
      fable5,
      "fable 5.1 must bill exactly like fable 5 until it gets its own row"
    );
  });

  it("does not fall through to the opus tier", () => {
    const fable51 = resolveModelPricing(CATALOG, "claude", "claude-fable-5-1").pricing as Record<
      string,
      number
    >;
    const opus = resolveModelPricing(CATALOG, "claude", "claude-opus-4-8").pricing as Record<
      string,
      number
    >;
    assert.notDeepEqual(fable51, opus, "fable is priced above opus — anchoring there undercharges");
  });
});
