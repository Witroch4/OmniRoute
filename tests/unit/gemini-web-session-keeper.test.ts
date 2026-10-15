import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gweb-keeper-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const {
  applyGeminiWebCookieUpdates,
  createGeminiWebKeeperState,
  geminiWebRotateIntervalMs,
  isGeminiWebSessionKeeperEnabled,
  sweepGeminiWebSessions,
} = await import("../../src/lib/geminiWebSessionKeeper.ts");
const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.ts");
const { GeminiWebGate, DEFAULT_GEMINI_WEB_GATE_CONFIG, __setGeminiWebGateForTests } =
  await import("../../open-sse/services/geminiWebGate.ts");

__setGeminiWebGateForTests(
  new GeminiWebGate({
    ...DEFAULT_GEMINI_WEB_GATE_CONFIG,
    minIntervalMs: 0,
    jitterMs: 0,
    window: { requests: 0, windowMs: 1 },
  })
);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

type RotateOutcome = import("../../open-sse/services/geminiWebSession.ts").GeminiWebRotateOutcome;

type Conn = {
  id: string;
  name?: string;
  isActive?: boolean;
  apiKey?: string | null;
  testStatus?: string | null;
  lastErrorSource?: string | null;
};

function makeDeps(
  initial: Conn[],
  opts: { rotate?: (cookie: string) => Promise<RotateOutcome> } = {}
) {
  const store = new Map(initial.map((c) => [c.id, { ...c }]));
  const clock = { now: 1_000_000 };
  const rotateCalls: string[] = [];
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const logs: string[] = [];
  let challenge = false;

  const deps = {
    now: () => clock.now,
    listConnections: async () => [...store.values()].map((c) => ({ ...c })),
    getConnection: async (id: string) => (store.has(id) ? { ...store.get(id)! } : null),
    updateConnection: async (id: string, data: Record<string, unknown>) => {
      writes.push({ id, data });
      Object.assign(store.get(id)!, data);
    },
    rotate: async (cookie: string) => {
      rotateCalls.push(cookie);
      return opts.rotate ? opts.rotate(cookie) : { status: "unchanged" as const, cookie };
    },
    challengeActive: () => challenge,
    log: {
      info: (m: string) => logs.push(`info:${m}`),
      warn: (m: string) => logs.push(`warn:${m}`),
    },
  };
  return {
    deps,
    store,
    clock,
    rotateCalls,
    writes,
    logs,
    setChallenge: (value: boolean) => {
      challenge = value;
    },
  };
}

const INTERVAL = 5 * 60_000;
const COOKIE = "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-0; SID=sid";

// ─── Config ─────────────────────────────────────────────────────────────────

test("config: 5 min default, env override clamped to >= 1 min, kill switch", () => {
  assert.equal(geminiWebRotateIntervalMs({}), 5 * 60_000);
  assert.equal(geminiWebRotateIntervalMs({ GEMINI_WEB_ROTATE_INTERVAL_MS: "120000" }), 120_000);
  assert.equal(geminiWebRotateIntervalMs({ GEMINI_WEB_ROTATE_INTERVAL_MS: "5" }), 5 * 60_000);
  assert.equal(isGeminiWebSessionKeeperEnabled({}), true);
  assert.equal(isGeminiWebSessionKeeperEnabled({ GEMINI_WEB_SESSION_KEEPER: "0" }), false);
  assert.equal(isGeminiWebSessionKeeperEnabled({ GEMINI_WEB_SESSION_KEEPER: "off" }), false);
});

// ─── Sweep ──────────────────────────────────────────────────────────────────

test("sweep rotates a due connection, merges the deltas, and waits a full interval", async () => {
  const h = makeDeps([{ id: "c1", name: "gweb", apiKey: COOKIE }], {
    rotate: async (cookie) => ({
      status: "rotated",
      cookie,
      changed: ["__Secure-1PSIDTS"],
      updates: [{ name: "__Secure-1PSIDTS", value: "ts-1" }],
    }),
  });
  const state = createGeminiWebKeeperState();

  const first = await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(first.rotated, 1);
  assert.equal(h.store.get("c1")!.apiKey, "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-1; SID=sid");
  assert.equal(h.rotateCalls.length, 1);
  assert.ok(h.writes.some((w) => "lastHealthCheckAt" in w.data));

  // Not due yet: no second call.
  h.clock.now += INTERVAL - 1;
  await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(h.rotateCalls.length, 1);

  // Due again.
  h.clock.now += 2;
  await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(h.rotateCalls.length, 2);
  // It rotates the header it just stored, not the original paste.
  assert.match(h.rotateCalls[1], /__Secure-1PSIDTS=ts-1/);
});

test("sweep ignores inactive connections and ones without a session cookie", async () => {
  const h = makeDeps([
    { id: "off", isActive: false, apiKey: COOKIE },
    { id: "anon", apiKey: "NID=1; SID=2" },
    { id: "empty", apiKey: null },
  ]);
  await sweepGeminiWebSessions(h.deps, createGeminiWebKeeperState(), INTERVAL);
  assert.equal(h.rotateCalls.length, 0);
});

test("sweep marks a 401 connection expired once and stays quiet until the cookie changes", async () => {
  const h = makeDeps([{ id: "c1", apiKey: COOKIE }], {
    rotate: async () => ({ status: "unauthorized", httpStatus: 401 }),
  });
  const state = createGeminiWebKeeperState();

  const first = await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(first.unauthorized, 1);
  assert.equal(h.store.get("c1")!.testStatus, "expired");
  assert.equal(h.store.get("c1")!.lastErrorSource, "gemini_web_session_keeper");
  assert.equal(h.rotateCalls.length, 1);

  // Same dead header: never retried, however much time passes.
  h.clock.now += 10 * INTERVAL;
  await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(h.rotateCalls.length, 1, "a dead cookie must not be hammered");

  // A fresh paste is tried at once.
  h.store.get("c1")!.apiKey = "__Secure-1PSID=psid; __Secure-1PSIDTS=pasted-fresh";
  await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(h.rotateCalls.length, 2);
});

test("sweep heals only the expired state it wrote itself", async () => {
  const ours = makeDeps(
    [
      {
        id: "c1",
        apiKey: COOKIE,
        testStatus: "expired",
        lastErrorSource: "gemini_web_session_keeper",
      },
    ],
    { rotate: async (cookie) => ({ status: "unchanged", cookie }) }
  );
  await sweepGeminiWebSessions(ours.deps, createGeminiWebKeeperState(), INTERVAL);
  assert.equal(ours.store.get("c1")!.testStatus, "active");
  assert.equal(ours.store.get("c1")!.lastErrorSource, null);

  // An "expired" the executor set (signed-out page) is not ours to clear.
  const theirs = makeDeps(
    [{ id: "c1", apiKey: COOKIE, testStatus: "expired", lastErrorSource: "chat" }],
    { rotate: async (cookie) => ({ status: "unchanged", cookie }) }
  );
  await sweepGeminiWebSessions(theirs.deps, createGeminiWebKeeperState(), INTERVAL);
  assert.equal(theirs.store.get("c1")!.testStatus, "expired");
});

test("sweep backs off briefly on a transport error and keeps going", async () => {
  let fail = true;
  const h = makeDeps([{ id: "c1", apiKey: COOKIE }], {
    rotate: async (cookie) =>
      fail ? { status: "error", message: "ETIMEDOUT" } : { status: "unchanged", cookie },
  });
  const state = createGeminiWebKeeperState();

  const first = await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(first.failed, 1);
  assert.equal(
    h.store.get("c1")!.testStatus ?? null,
    null,
    "a network blip must not mark it expired"
  );

  h.clock.now += 60_000; // still inside the 2 min retry window
  await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(h.rotateCalls.length, 1);

  fail = false;
  h.clock.now += 61_000;
  const retry = await sweepGeminiWebSessions(h.deps, state, INTERVAL);
  assert.equal(h.rotateCalls.length, 2);
  assert.equal(retry.unchanged, 1);
});

test("sweep does not touch accounts.google.com while the challenge cooldown is on", async () => {
  const h = makeDeps([{ id: "c1", apiKey: COOKIE }]);
  h.setChallenge(true);
  const summary = await sweepGeminiWebSessions(h.deps, createGeminiWebKeeperState(), INTERVAL);
  assert.equal(summary.skipped, "challenge");
  assert.equal(h.rotateCalls.length, 0);
});

test("sweep never leaks the cookie value into its logs", async () => {
  const h = makeDeps([{ id: "c1", name: "gweb", apiKey: COOKIE }], {
    rotate: async (cookie) => ({
      status: "rotated",
      cookie,
      changed: ["__Secure-1PSIDTS"],
      updates: [{ name: "__Secure-1PSIDTS", value: "super-secret-ts" }],
    }),
  });
  await sweepGeminiWebSessions(h.deps, createGeminiWebKeeperState(), INTERVAL);
  const text = h.logs.join("\n");
  assert.ok(text.includes("__Secure-1PSIDTS"));
  assert.equal(text.includes("super-secret-ts"), false);
  assert.equal(text.includes("psid"), false);
});

// ─── Single writer ──────────────────────────────────────────────────────────

test("applyGeminiWebCookieUpdates serialises writers so neither loses the other's delta", async () => {
  const h = makeDeps([{ id: "c1", apiKey: "__Secure-1PSID=p; __Secure-1PSIDTS=ts-0; SIDCC=cc-0" }]);
  // Hand back the snapshot AFTER a pause, so an unlocked read-modify-write works from a stale
  // header (the lost-update race this lock exists to prevent).
  const slowGet = h.deps.getConnection;
  h.deps.getConnection = async (id: string) => {
    const snapshot = await slowGet(id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return snapshot;
  };

  await Promise.all([
    applyGeminiWebCookieUpdates("c1", [{ name: "__Secure-1PSIDTS", value: "ts-1" }], h.deps),
    applyGeminiWebCookieUpdates("c1", [{ name: "SIDCC", value: "cc-1" }], h.deps),
  ]);

  assert.equal(h.store.get("c1")!.apiKey, "__Secure-1PSID=p; __Secure-1PSIDTS=ts-1; SIDCC=cc-1");
});

test("applyGeminiWebCookieUpdates never creates a session out of deltas", async () => {
  const h = makeDeps([{ id: "c1", apiKey: null }]);
  const changed = await applyGeminiWebCookieUpdates(
    "c1",
    [{ name: "__Secure-1PSIDTS", value: "ts" }],
    h.deps
  );
  assert.equal(changed, false);
  assert.equal(h.store.get("c1")!.apiKey, null);
});

// ─── Executor → database (real sqlite, mocked browser) ──────────────────────

test("executor stores what the page rotated and maps __Host- cookies by URL", async () => {
  const connection = (await providersDb.createProviderConnection({
    provider: "gemini-web",
    authType: "apikey",
    name: "gweb keeper test",
    apiKey: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-old; __Host-1PLSID=host; SID=sid",
  })) as { id: string };

  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  let added: Array<Record<string, unknown>> = [];

  playwright.chromium.launch = async () =>
    ({
      newContext: async () => ({
        addCookies: async (cookies: Array<Record<string, unknown>>) => {
          // Chromium rejects the whole batch for a __Host- cookie that has a Domain.
          for (const cookie of cookies) {
            if (String(cookie.name).startsWith("__Host-") && "domain" in cookie) {
              throw new Error("Storage.setCookies: Invalid cookie fields");
            }
          }
          added = cookies;
        },
        cookies: async () => [
          { name: "__Secure-1PSID", value: "psid", domain: ".google.com" },
          { name: "__Secure-1PSIDTS", value: "ts-rotated", domain: ".google.com" },
          { name: "__Secure-3PSIDTS", value: "ts3-rotated", domain: ".google.com" },
          { name: "NID", value: "tracking", domain: ".google.com" },
        ],
        newPage: async () => ({
          on: () => {},
          goto: async () => {},
          url: () => "https://gemini.google.com/app",
          evaluate: async () => ({ text: "3.1 Pro", aria: "" }),
          waitForTimeout: async () => {},
          waitForSelector: async () => ({ click: async () => {} }),
          keyboard: { type: async () => {}, press: async () => {} },
        }),
      }),
      close: async () => {},
    }) as never;

  try {
    const executor = new GeminiWebExecutor();
    const header = (await providersDb.getProviderConnectionById(connection.id)) as {
      apiKey: string;
    };
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false,
      credentials: { apiKey: header.apiKey, connectionId: connection.id } as never,
      signal: AbortSignal.timeout(5000),
      log: null,
    });
    // The fake page produces no StreamGenerate reply -> 502, but the cookies were harvested.
    assert.equal(result.response.status, 502);

    const hostCookie = added.find((c) => c.name === "__Host-1PLSID");
    assert.ok(hostCookie, "the __Host- cookie must reach the browser");
    assert.equal(hostCookie!.url, "https://accounts.google.com/");

    const stored = (await providersDb.getProviderConnectionById(connection.id)) as {
      apiKey: string;
    };
    assert.equal(
      stored.apiKey,
      "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-rotated; __Host-1PLSID=host; SID=sid; " +
        "__Secure-3PSIDTS=ts3-rotated"
    );
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});
