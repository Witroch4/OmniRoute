import test from "node:test";
import assert from "node:assert/strict";

import type { ModelBudgetRule } from "../../../src/lib/db/apiKeyModelBudgetRules.ts";
import {
  clearModelBudgetRoutingCacheForTests,
  resolveModelBudgetRedirect,
} from "../../../src/lib/usage/modelBudgetRouting.ts";

const WINDOW_START = "2026-08-01T00:00:00.000Z";

function rule(partial: Partial<ModelBudgetRule> & { sourceFamily: string; targetFamily: string }) {
  return {
    id: `rule-${partial.sourceFamily}`,
    apiKeyId: "key-1",
    enabled: true,
    priority: 0,
    sourceProvider: "cc",
    weeklyLimitUsd: 100,
    targetProvider: "cc",
    ...partial,
  } as ModelBudgetRule;
}

function depsWith(rules: ModelBudgetRule[], spend: Record<string, number>) {
  return {
    listRules: () => rules,
    getFamilySpend: async (_key: string, _provider: string, glob: string) => spend[glob] ?? 0,
    resolveTarget: (_provider: string, glob: string) => glob.replace("-*", "-5"),
    getWindowStartIso: async () => WINDOW_START,
    warn: () => {},
  };
}

test("no redirect while the family is under its cap", async () => {
  clearModelBudgetRoutingCacheForTests();
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    depsWith([rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-sonnet-*" })], {
      "claude-opus-*": 99.99,
    })
  );
  assert.equal(redirect, null);
});

test("one hop once the cap is reached", async () => {
  clearModelBudgetRoutingCacheForTests();
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    depsWith([rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-sonnet-*" })], {
      "claude-opus-*": 100,
    })
  );
  assert.deepEqual(redirect, {
    provider: "cc",
    model: "claude-sonnet-5",
    billedProvider: "cc",
    billedModel: "claude-opus-4-8",
    ruleId: "rule-claude-opus-*",
    hops: 1,
  });
});

test("the ladder descends and always bills the ORIGINAL model", async () => {
  clearModelBudgetRoutingCacheForTests();
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    depsWith(
      [
        rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-sonnet-*" }),
        rule({
          sourceFamily: "claude-sonnet-*",
          targetFamily: "claude-haiku-*",
          weeklyLimitUsd: 50,
        }),
      ],
      { "claude-opus-*": 100, "claude-sonnet-*": 50 }
    )
  );
  assert.equal(redirect?.model, "claude-haiku-5");
  assert.equal(
    redirect?.billedModel,
    "claude-opus-4-8",
    "billed pair is the first hop, never a rung"
  );
  assert.equal(redirect?.hops, 2);
});

test("a rule whose target glob resolves to nothing is inert", async () => {
  clearModelBudgetRoutingCacheForTests();
  const warnings: string[] = [];
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    {
      ...depsWith([rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-ghost-*" })], {
        "claude-opus-*": 100,
      }),
      resolveTarget: () => null,
      warn: (message: string) => warnings.push(message),
    }
  );
  assert.equal(redirect, null);
  assert.equal(warnings.length, 1);
});

test("a self-referential rule cannot loop", async () => {
  clearModelBudgetRoutingCacheForTests();
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    depsWith([rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-opus-*" })], {
      "claude-opus-*": 100,
    })
  );
  assert.equal(redirect?.model, "claude-opus-5");
  assert.equal(redirect?.hops, 1, "the visited guard must stop the second hop");
});

test("a key with no rules never queries spend", async () => {
  clearModelBudgetRoutingCacheForTests();
  let queried = 0;
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    {
      listRules: () => [],
      getFamilySpend: async () => {
        queried += 1;
        return 999;
      },
      resolveTarget: () => "claude-sonnet-5",
      getWindowStartIso: async () => WINDOW_START,
      warn: () => {},
    }
  );
  assert.equal(redirect, null);
  assert.equal(queried, 0);
});

test("spend is read once per rule and then cached", async () => {
  clearModelBudgetRoutingCacheForTests();
  let queried = 0;
  const deps = {
    listRules: () => [rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-sonnet-*" })],
    getFamilySpend: async () => {
      queried += 1;
      return 100;
    },
    resolveTarget: (_p: string, glob: string) => glob.replace("-*", "-5"),
    getWindowStartIso: async () => WINDOW_START,
    warn: () => {},
  };
  const input = { apiKeyId: "key-cache", provider: "cc", model: "claude-opus-4-8" };

  await resolveModelBudgetRedirect(input, deps);
  await resolveModelBudgetRedirect(input, deps);

  assert.equal(queried, 1, "the second call must be served from the TTL cache");
});

test("a key with a rule that doesn't match this request never fetches the window or queries spend", async () => {
  clearModelBudgetRoutingCacheForTests();
  let windowFetched = 0;
  let spendQueried = 0;
  const redirect = await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "gpt-5" },
    {
      listRules: () => [rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-sonnet-*" })],
      getFamilySpend: async () => {
        spendQueried += 1;
        return 999;
      },
      resolveTarget: (_p: string, glob: string) => glob.replace("-*", "-5"),
      getWindowStartIso: async () => {
        windowFetched += 1;
        return WINDOW_START;
      },
      warn: () => {},
    }
  );
  assert.equal(redirect, null);
  assert.equal(
    windowFetched,
    0,
    "the weekly window must be fetched lazily, not for every key with a rule"
  );
  assert.equal(spendQueried, 0);
});

// Final-review Finding 5: matchesFamilyGlob (decides eligibility here) strips a model id
// down to its bare form before matching; the REAL spend query (apiKeyUsageLimits.ts's
// getApiKeyFamilyRealSpendSince) runs `LOWER(model) GLOB @familyGlob` against the FULL
// stored id, with no stripping. For a provider whose registry id itself carries a slash
// (cline's "anthropic/claude-sonnet-4.6"), a no-leading-wildcard source glob like
// "claude-sonnet-*" matches the bare id but can never match the full one — real spend on
// that family reads 0 forever and the rule never exhausts. Fails safe (never a bad
// request), but silently — this locks the warn-once signal that is the only thing that
// makes the misconfiguration visible.
test("a slash-bearing model id that structurally can never match the spend query warns once per rule", async () => {
  clearModelBudgetRoutingCacheForTests();
  const warnings: string[] = [];
  const deps = {
    ...depsWith(
      [
        rule({
          sourceProvider: "cline",
          sourceFamily: "claude-sonnet-*",
          targetProvider: "cline",
          targetFamily: "claude-haiku-*",
        }),
      ],
      { "claude-sonnet-*": 100 }
    ),
    warn: (message: string) => warnings.push(message),
  };
  const input = {
    apiKeyId: "key-1",
    provider: "cline",
    model: "anthropic/claude-sonnet-4.6",
  };

  const first = await resolveModelBudgetRedirect(input, deps);
  const second = await resolveModelBudgetRedirect(input, deps);

  // The redirect itself still fires (matchesFamilyGlob matched, and the mocked
  // getFamilySpend here returns 100 regardless of the real SQL query's actual
  // behavior) — this test is about the WARNING, not about breaking the redirect.
  assert.ok(first, "matchesFamilyGlob still decides eligibility off the bare id");
  assert.ok(second);
  assert.equal(warnings.length, 1, "must warn exactly once per rule, not once per call");
  assert.match(warnings[0], /rule-claude-sonnet-\*/);
  assert.match(warnings[0], /anthropic\/claude-sonnet-4\.6/);
});

test("a slash-bearing model id that DOES structurally match the spend query does not warn", async () => {
  clearModelBudgetRoutingCacheForTests();
  const warnings: string[] = [];
  const deps = {
    ...depsWith(
      [
        rule({
          sourceProvider: "cline",
          sourceFamily: "*claude-sonnet-*",
          targetProvider: "cline",
          targetFamily: "claude-haiku-*",
        }),
      ],
      { "*claude-sonnet-*": 100 }
    ),
    warn: (message: string) => warnings.push(message),
  };

  // A leading wildcard spans the "anthropic/" prefix, so the SQL GLOB against the
  // FULL id would match too — no structural mismatch, no warning.
  await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cline", model: "anthropic/claude-sonnet-4.6" },
    deps
  );

  assert.equal(warnings.length, 0);
});

test("a non-slash-bearing model id never warns, even with a narrow glob", async () => {
  clearModelBudgetRoutingCacheForTests();
  const warnings: string[] = [];
  const deps = {
    ...depsWith([rule({ sourceFamily: "claude-opus-*", targetFamily: "claude-sonnet-*" })], {
      "claude-opus-*": 100,
    }),
    warn: (message: string) => warnings.push(message),
  };

  await resolveModelBudgetRedirect(
    { apiKeyId: "key-1", provider: "cc", model: "claude-opus-4-8" },
    deps
  );

  assert.equal(
    warnings.length,
    0,
    "the common case (no slash in the stored model id) is unaffected"
  );
});
