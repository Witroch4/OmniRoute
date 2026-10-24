/**
 * tests/unit/image-account-failover.test.ts
 *
 * The image routes picked ONE credential and returned its answer. A model that
 * only some accounts own (Codex Sol / Astra sit on one ChatGPT account, Terra /
 * Luna on both) therefore failed with `400 The 'gpt-6-sol' model is not
 * supported when using Codex with a ChatGPT account` on /v1/images/generations
 * while the same model answered 200 on /v1/responses a moment later — the chat
 * path re-serves on the next account, the image path did not.
 *
 * `retryImageOnOtherAccounts` gives the image routes that same step, but only
 * for the class the shared classifier already treats as zero-cooldown account
 * fallback, and without writing anything to the connection.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isModelUnavailableOnAccount,
  markModelUnavailableAsRetryable,
  retryImageOnOtherAccounts,
} from "../../src/lib/images/imageAccountFailover.ts";

const SOL_400 = JSON.stringify({
  message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
  type: "upstream_error",
  code: "upstream_error",
});

type Creds = { connectionId: string | null; allRateLimited?: boolean };
type Res = { success: boolean; status?: number; error?: unknown; servedBy?: string };

const gmail: Creds = { connectionId: "49bd610e-aaaa" };
const hotmail: Creds = { connectionId: "a095273c-bbbb" };

function harness(accounts: Record<string, Res>, queue: Creds[]) {
  const picked: string[][] = [];
  const attempted: string[] = [];
  return {
    picked,
    attempted,
    run: (first: Creds, options: { maxAccountAttempts?: number; firstResult?: Res } = {}) =>
      retryImageOnOtherAccounts<Creds, Res>({
        provider: "codex",
        model: "codex/gpt-6-sol",
        credentials: first,
        result: options.firstResult ?? accounts[first.connectionId as string],
        getFailure: (r) => (r.success ? null : { status: r.status, error: r.error }),
        pickNext: async (excluded) => {
          picked.push([...excluded]);
          return queue.shift() ?? null;
        },
        attempt: async (c) => {
          attempted.push(c.connectionId as string);
          return accounts[c.connectionId as string];
        },
        ...options,
      }),
  };
}

test("the Sol 400 is classified as 'another account may serve this'", () => {
  assert.equal(isModelUnavailableOnAccount(400, SOL_400, "codex"), true);
  assert.equal(isModelUnavailableOnAccount(400, "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", "codex"), true);
});

test("errors another account cannot fix are not retried", () => {
  const moderation = JSON.stringify({ message: "rejected by the safety system", code: "moderation_blocked" });
  assert.equal(isModelUnavailableOnAccount(400, moderation, "codex"), false);
  assert.equal(isModelUnavailableOnAccount(400, "Invalid value: 'size'.", "codex"), false);
  // 429 / 5xx carry their own cooldown semantics and keep their previous behaviour
  assert.equal(isModelUnavailableOnAccount(429, SOL_400, "codex"), false);
  assert.equal(isModelUnavailableOnAccount(500, SOL_400, "codex"), false);
  assert.equal(isModelUnavailableOnAccount(undefined, SOL_400, "codex"), false);
});

test("Sol 400 on the first account is re-served by the second", async () => {
  const h = harness(
    {
      [gmail.connectionId as string]: { success: false, status: 400, error: SOL_400 },
      [hotmail.connectionId as string]: { success: true, servedBy: "hotmail" },
    },
    [hotmail]
  );
  const out = await h.run(gmail);
  assert.equal(out.result.success, true);
  assert.equal(out.credentials.connectionId, hotmail.connectionId);
  assert.deepEqual(h.attempted, [hotmail.connectionId]);
  assert.deepEqual(h.picked, [[gmail.connectionId]], "the failed account is excluded from the next pick");
});

test("a first-account success never asks for another account", async () => {
  const h = harness({ [gmail.connectionId as string]: { success: true } }, [hotmail]);
  const out = await h.run(gmail);
  assert.equal(out.result.success, true);
  assert.deepEqual(h.picked, []);
  assert.deepEqual(h.attempted, []);
});

test("when every account refuses, the last real error is returned and each account is tried once", async () => {
  const refuse: Res = { success: false, status: 400, error: SOL_400 };
  const h = harness(
    { [gmail.connectionId as string]: refuse, [hotmail.connectionId as string]: refuse },
    [hotmail]
  );
  const out = await h.run(gmail);
  assert.equal(out.result.success, false);
  assert.equal(out.result.status, 400);
  assert.deepEqual(h.attempted, [hotmail.connectionId]);
  assert.equal(h.picked.length, 2, "second pick finds nothing left");
});

test("a non-retryable failure stops at the first account", async () => {
  const h = harness(
    {
      [gmail.connectionId as string]: {
        success: false,
        status: 400,
        error: JSON.stringify({ message: "rejected by the safety system", code: "moderation_blocked" }),
      },
    },
    [hotmail]
  );
  const out = await h.run(gmail);
  assert.equal(out.result.success, false);
  assert.deepEqual(h.picked, []);
  assert.deepEqual(h.attempted, []);
});

test("a rate-limited or repeated pick ends the retry instead of looping", async () => {
  const refuse: Res = { success: false, status: 400, error: SOL_400 };
  const rateLimited = await harness({ [gmail.connectionId as string]: refuse }, [
    { connectionId: "x", allRateLimited: true },
  ]).run(gmail);
  assert.equal(rateLimited.result.success, false);

  const same = harness({ [gmail.connectionId as string]: refuse }, [gmail]);
  const out = await same.run(gmail);
  assert.equal(out.result.success, false);
  assert.deepEqual(same.attempted, [], "a connection already tried is never re-attempted");
});

test("credential-less (no-auth) providers are never retried", async () => {
  const h = harness({}, [hotmail]);
  const out = await h.run(
    { connectionId: null },
    { firstResult: { success: false, status: 400, error: SOL_400 } }
  );
  assert.equal(out.result.success, false);
  assert.equal(out.credentials.connectionId, null);
  assert.deepEqual(h.attempted, []);
  assert.deepEqual(h.picked, []);
});

test("maxAccountAttempts bounds the walk across many accounts", async () => {
  const refuse: Res = { success: false, status: 400, error: SOL_400 };
  const many: Creds[] = ["a", "b", "c", "d"].map((id) => ({ connectionId: id }));
  const accounts: Record<string, Res> = {
    [gmail.connectionId as string]: refuse,
    a: refuse,
    b: refuse,
    c: refuse,
    d: { success: true },
  };
  const h = harness(accounts, [...many]);
  const out = await h.run(gmail, { maxAccountAttempts: 2 });
  assert.equal(out.result.success, false);
  assert.equal(h.attempted.length, 2);
});

test("a throwing pick keeps the original failure", async () => {
  const out = await retryImageOnOtherAccounts<Creds, Res>({
    provider: "codex",
    model: "codex/gpt-6-sol",
    credentials: gmail,
    result: { success: false, status: 400, error: SOL_400 },
    getFailure: (r) => (r.success ? null : { status: r.status, error: r.error }),
    pickNext: async () => {
      throw new Error("db unavailable");
    },
    attempt: async () => ({ success: true }),
  });
  assert.equal(out.result.success, false);
  assert.equal(out.credentials.connectionId, gmail.connectionId);
});

// 3.8.53 sync: both image routes now run upstream's single account loop
// (executeImageWithCredentialFallback, #8307). The fork's class reaches that loop as a
// `retryable` flag, so these lock the flag and the loop honouring it.
test("markModelUnavailableAsRetryable flags only the 400 another account can serve", () => {
  const sol: Res = { success: false, status: 400, error: SOL_400 };
  assert.equal(markModelUnavailableAsRetryable("codex", sol).retryable, true);
  assert.equal(sol.retryable, undefined, "the original result is not mutated");

  const moderation: Res = {
    success: false,
    status: 400,
    error: JSON.stringify({ message: "rejected by the safety system", code: "moderation_blocked" }),
  };
  assert.equal(markModelUnavailableAsRetryable("codex", moderation).retryable, undefined);
  assert.equal(
    markModelUnavailableAsRetryable("codex", { success: false, status: 429, error: SOL_400 })
      .retryable,
    undefined
  );
  const ok: Res = { success: true };
  assert.equal(markModelUnavailableAsRetryable("codex", ok), ok);
});

test("upstream's image account loop re-serves the fork's class on the next account", async () => {
  const { executeImageWithCredentialFallback } =
    await import("../../src/sse/services/imageCredentialRetry.ts");
  const first = { connectionId: "49bd610e-aaaa", accessToken: "t1" };
  const second = { connectionId: "a095273c-bbbb", accessToken: "t2" };
  const attempted: string[] = [];

  const { credentials, result } = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "codex/gpt-6-sol",
    credentials: first,
    selectNextCredentials: async (_provider, _model, excluded) =>
      excluded.has(second.connectionId) ? null : second,
    execute: async (creds: { connectionId: string }) => {
      attempted.push(creds.connectionId);
      const raw =
        creds.connectionId === first.connectionId
          ? { success: false, status: 400, error: SOL_400 }
          : { success: true, status: 200, data: { created: 1, data: [] } };
      return markModelUnavailableAsRetryable("codex", raw);
    },
  });

  assert.equal(result.success, true);
  assert.equal(credentials.connectionId, second.connectionId);
  assert.deepEqual(attempted, [first.connectionId, second.connectionId]);
});
