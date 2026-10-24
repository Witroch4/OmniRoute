// Guard ported from upstream f204c4ec2c (#14211). Upstream's Antigravity-specific
// quota path kept a 429-sourced exhaustion forever; this fork routes agy/antigravity
// through the generic EXHAUSTED_TTL_MS path, which already expires it. The test pins
// that behaviour so a future upstream sync cannot reintroduce the stuck exhaustion.
import test from "node:test";
import assert from "node:assert/strict";

import * as quotaCache from "../../src/domain/quotaCache.ts";

test("Antigravity 429 exhaustion expires after the fixed TTL", () => {
  quotaCache.__clearForTests();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    for (const [provider, model] of [
      ["antigravity", "antigravity/claude-sonnet-4-6"],
      ["agy", "agy/claude-sonnet-4-6"],
    ] as const) {
      const connectionId = `conn-${provider}-429-ttl`;
      quotaCache.markAccountExhaustedFrom429(connectionId, provider);

      assert.equal(
        quotaCache.isQuotaExhaustedForRequest(connectionId, provider, model),
        true,
        `${provider} should be exhausted during the fixed TTL`
      );

      now += 5 * 60 * 1000 + 1;

      assert.equal(
        quotaCache.isQuotaExhaustedForRequest(connectionId, provider, model),
        false,
        `${provider} should recover after the fixed TTL`
      );
    }
  } finally {
    Date.now = originalNow;
    quotaCache.__clearForTests();
  }
});
