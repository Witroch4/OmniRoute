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
