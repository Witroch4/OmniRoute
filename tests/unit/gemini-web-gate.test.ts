import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const {
  GeminiWebGate,
  GeminiWebGateError,
  DEFAULT_GEMINI_WEB_GATE_CONFIG,
  geminiWebAccountKey,
  loadGeminiWebGateConfig,
  __setGeminiWebGateForTests,
} = await import("../../open-sse/services/geminiWebGate.ts");
const {
  GeminiWebExecutor,
  GeminiWebModelSelectionError,
  geminiWebMenuItemPattern,
  isGoogleChallengeUrl,
  resolveGeminiWebReasoning,
  selectGeminiWebModel,
  selectGeminiWebReasoning,
} = await import("../../open-sse/executors/gemini-web.ts");
const { GEMINI_WEB_MODELS, findGeminiWebModel } =
  await import("../../open-sse/config/providers/registry/gemini/web/models.ts");

// No pacing / window cap unless a test asks for it.
const FAST = {
  ...DEFAULT_GEMINI_WEB_GATE_CONFIG,
  minIntervalMs: 0,
  jitterMs: 0,
  window: { requests: 0, windowMs: 1 },
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function isSettled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  await tick();
  await tick();
  return done;
}

// ─── Gate ───────────────────────────────────────────────────────────────────

test("gate: an account runs at most maxConcurrentPerAccount requests at once", async () => {
  const gate = new GeminiWebGate({
    ...FAST,
    maxBrowsers: 5,
    maxConcurrentPerAccount: 2,
    maxQueueDepth: 10,
  });
  const p1 = await gate.acquire("a");
  const p2 = await gate.acquire("a");
  const third = gate.acquire("a");
  assert.equal(await isSettled(third), false, "third request of the same account must wait");

  p1.release();
  const p3 = await third;
  p2.release();
  p3.release();
  assert.equal(gate.stats().pending, 0);
});

test("gate: the global browser cap holds across accounts", async () => {
  const gate = new GeminiWebGate({
    ...FAST,
    maxBrowsers: 2,
    maxConcurrentPerAccount: 2,
    maxQueueDepth: 10,
  });
  const a = await gate.acquire("a");
  const b = await gate.acquire("b");
  const c = gate.acquire("c");
  assert.equal(await isSettled(c), false, "only 2 Chromium sessions may run at once");

  a.release();
  const pc = await c;
  b.release();
  pc.release();
});

test("gate: a full queue is refused with 429 instead of piling up", async () => {
  const gate = new GeminiWebGate({
    ...FAST,
    maxConcurrentPerAccount: 1,
    maxQueueDepth: 2,
  });
  const first = await gate.acquire("a");
  const second = gate.acquire("a");
  await tick();

  await assert.rejects(
    gate.acquire("a"),
    (err: unknown) =>
      err instanceof GeminiWebGateError &&
      err.code === "queue_full" &&
      err.status === 429 &&
      err.retryAfterMs >= 1000
  );

  first.release();
  (await second).release();
  assert.equal(gate.stats().pending, 0);
});

test("gate: the sliding-window cap rejects with a Retry-After and frees up afterwards", async () => {
  let t = 1_000_000;
  const gate = new GeminiWebGate(
    { ...FAST, window: { requests: 2, windowMs: 60_000 } },
    { now: () => t }
  );
  (await gate.acquire("a")).release();
  (await gate.acquire("a")).release();

  await assert.rejects(
    gate.acquire("a"),
    (err: unknown) =>
      err instanceof GeminiWebGateError &&
      err.code === "rate_window" &&
      err.retryAfterMs > 55_000 &&
      err.retryAfterMs <= 60_000
  );
  // Another account has its own window.
  (await gate.acquire("b")).release();

  t += 60_001;
  (await gate.acquire("a")).release();
});

test("gate: a request that waits too long is rejected and the permit is not lost", async () => {
  const gate = new GeminiWebGate({
    ...FAST,
    maxConcurrentPerAccount: 1,
    maxQueueWaitMs: 30,
  });
  const first = await gate.acquire("a");
  await assert.rejects(
    gate.acquire("a"),
    (err: unknown) => err instanceof GeminiWebGateError && err.code === "queue_timeout"
  );
  first.release();
  (await gate.acquire("a")).release();
  assert.equal(gate.stats().pending, 0);
});

test("gate: an aborted waiter leaves the queue without leaking a permit", async () => {
  const gate = new GeminiWebGate({ ...FAST, maxConcurrentPerAccount: 1 });
  const first = await gate.acquire("a");
  const controller = new AbortController();
  const caught = gate.acquire("a", controller.signal).catch((err: Error) => err);
  await tick();
  controller.abort(new Error("client left"));

  const err = (await caught) as Error;
  assert.equal(err.name, "AbortError");
  assert.equal(gate.stats().pending, 1);

  first.release();
  assert.equal(gate.stats().pending, 0);
  (await gate.acquire("a")).release();
});

test("gate: starts of the same account are staggered by minIntervalMs", async () => {
  const t = 2_000_000;
  const sleeps: number[] = [];
  const gate = new GeminiWebGate(
    {
      ...FAST,
      maxBrowsers: 5,
      maxConcurrentPerAccount: 2,
      minIntervalMs: 8_000,
      jitterMs: 0,
    },
    {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    }
  );
  const p1 = await gate.acquire("a");
  assert.deepEqual(sleeps, [], "the first request starts immediately");
  const p2 = await gate.acquire("a");
  assert.deepEqual(sleeps, [8_000], "the second one is held back so they do not start together");
  p1.release();
  p2.release();
});

test("gate: jitter widens the gap but never shrinks it", async () => {
  const sleeps: number[] = [];
  const gate = new GeminiWebGate(
    {
      ...FAST,
      maxBrowsers: 5,
      maxConcurrentPerAccount: 2,
      minIntervalMs: 8_000,
      jitterMs: 4_000,
    },
    {
      now: () => 3_000_000,
      random: () => 0.5,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    }
  );
  const p1 = await gate.acquire("a");
  const p2 = await gate.acquire("a");
  assert.deepEqual(sleeps, [10_000]);
  p1.release();
  p2.release();
});

test("gate: a Google challenge stops running-queue requests and every new one until the cooldown ends", async () => {
  let t = 5_000;
  const gate = new GeminiWebGate(
    { ...FAST, maxConcurrentPerAccount: 1, challengeCooldownMs: 60_000 },
    { now: () => t }
  );
  const first = await gate.acquire("a");
  const queued = gate.acquire("a").then(
    () => "ran",
    (err: GeminiWebGateError) => err.code
  );
  await tick();

  gate.tripChallengeCooldown("google.com/sorry");
  first.release();
  assert.equal(await queued, "upstream_challenge", "queued work must not run into the captcha");

  await assert.rejects(
    gate.acquire("other-account"),
    (err: unknown) =>
      err instanceof GeminiWebGateError &&
      err.code === "upstream_challenge" &&
      err.retryAfterMs > 55_000
  );
  assert.ok(gate.stats().challengeRemainingMs > 0);

  // A later, shorter trip must not shorten an active cooldown.
  gate.tripChallengeCooldown("again", 1_000);
  assert.ok(gate.challengeRemainingMs() > 55_000);

  t += 60_001;
  (await gate.acquire("other-account")).release();
  assert.equal(gate.stats().challengeReason, null);
});

test("gate: release is idempotent", async () => {
  const gate = new GeminiWebGate({ ...FAST, maxBrowsers: 1, maxConcurrentPerAccount: 1 });
  const permit = await gate.acquire("a");
  permit.release();
  permit.release();
  const next = await gate.acquire("a");
  const waiting = gate.acquire("b");
  assert.equal(
    await isSettled(waiting),
    false,
    "a double release must not mint a second browser slot"
  );
  next.release();
  (await waiting).release();
});

test("account key is stable, per-PSID and does not contain the cookie", () => {
  const a1 = geminiWebAccountKey("__Secure-1PSID=secret-one; __Secure-1PSIDTS=ts-1");
  const a2 = geminiWebAccountKey("__Secure-1PSIDTS=ts-2; __Secure-1PSID=secret-one");
  const b = geminiWebAccountKey("__Secure-1PSID=secret-two");
  assert.equal(a1, a2, "rotating the PSIDTS must not change the account");
  assert.notEqual(a1, b);
  assert.match(a1, /^[0-9a-f]{16}$/);
  assert.ok(!a1.includes("secret"));
});

test("config: defaults, overrides and invalid values", () => {
  assert.deepEqual(loadGeminiWebGateConfig({}), DEFAULT_GEMINI_WEB_GATE_CONFIG);
  const cfg = loadGeminiWebGateConfig({
    GEMINI_WEB_MAX_BROWSERS: "1",
    GEMINI_WEB_MAX_CONCURRENT_PER_ACCOUNT: "1",
    GEMINI_WEB_MIN_INTERVAL_MS: "0",
    GEMINI_WEB_RATE_LIMIT_REQUESTS: "0",
    GEMINI_WEB_MAX_QUEUE_DEPTH: "nope",
    GEMINI_WEB_CHALLENGE_COOLDOWN_MS: "-5",
  });
  assert.equal(cfg.maxBrowsers, 1);
  assert.equal(cfg.maxConcurrentPerAccount, 1);
  assert.equal(cfg.minIntervalMs, 0);
  assert.equal(cfg.window.requests, 0, "0 disables the window cap");
  assert.equal(cfg.maxQueueDepth, DEFAULT_GEMINI_WEB_GATE_CONFIG.maxQueueDepth);
  assert.equal(cfg.challengeCooldownMs, DEFAULT_GEMINI_WEB_GATE_CONFIG.challengeCooldownMs);
});

test("defaults keep the production box safe: at most 2 browsers and 2 per account", () => {
  assert.equal(DEFAULT_GEMINI_WEB_GATE_CONFIG.maxBrowsers, 2);
  assert.equal(DEFAULT_GEMINI_WEB_GATE_CONFIG.maxConcurrentPerAccount, 2);
  assert.ok(DEFAULT_GEMINI_WEB_GATE_CONFIG.minIntervalMs >= 5_000);
  assert.ok(DEFAULT_GEMINI_WEB_GATE_CONFIG.window.requests > 0);
});

// ─── Catalog ────────────────────────────────────────────────────────────────

test("catalog: one id per (model, reasoning level), newest model first, high → low", () => {
  const ids = GEMINI_WEB_MODELS.map((m: { id: string }) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-low",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-medium",
    "gemini-3.1-pro-low",
    "gemini-3.5-flash-lite-high",
    "gemini-3.5-flash-lite-medium",
    "gemini-3.5-flash-lite-low",
  ]);
});

test("catalog: tier ids pin the level; a bare base id resolves but leaves the level alone", () => {
  const high = findGeminiWebModel("gweb/gemini-4-argon-high")!;
  assert.equal(high.uiLabel, "4 Argon");
  assert.equal(high.reasoning, "max");
  assert.equal(findGeminiWebModel("gemini-4-argon-medium")?.reasoning, "medium");
  assert.equal(findGeminiWebModel("gemini-3.8-flash-low")?.reasoning, "min");

  const base = findGeminiWebModel("gemini-4-argon")!;
  assert.equal(base.uiLabel, "4 Argon");
  assert.equal(base.reasoning, undefined);
  assert.equal(
    GEMINI_WEB_MODELS.some((m: { id: string }) => m.id === "gemini-4-argon"),
    false,
    "the base id is accepted but not advertised"
  );
  assert.equal(findGeminiWebModel("gemini-2.5-pro"), undefined);
  assert.equal(findGeminiWebModel("gemini-4-argon-ultra"), undefined);
});

// ─── Model picker (driven against a stub document) ──────────────────────────

interface FakeEl {
  innerText: string;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function fakeEl(innerText: string, attrs: Record<string, string> = {}): FakeEl {
  return {
    innerText,
    attrs: { ...attrs },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
}

/** Picker button text once a model is selected — measured on the live page, differs from the menu. */
const SHORT_PILL: Record<string, string> = {
  "4 Argon": "Argon",
  "3.8 Flash": "Flash",
  "3.1 Pro": "Pro",
  "3.5 Flash Lite": "Flash-Lite",
};

interface FakePickerOptions {
  /** Text the picker button shows initially. */
  pill: string;
  /** Aria-label of the picker button. */
  aria?: string;
  /** Menu entries as the page renders them ("<name> <subtitle>"). */
  menu: string[];
  /** When false, clicking a menu entry does not change the picker (UI drift). */
  applies?: boolean;
  /** No picker on the page at all. */
  noPicker?: boolean;
  /** Render the "Nível de raciocínio" section (3 levels) in the menu. */
  reasoning?: boolean;
  /** When false, clicking a level does not mark it checked (UI drift). */
  levelsApply?: boolean;
}

function makeFakePickerPage(opts: FakePickerOptions) {
  let open = false;
  const state = {
    pill: opts.pill,
    clicks: [] as string[],
    menuOpened: 0,
    level: null as string | null,
    expressions: [] as string[],
  };
  const pill = fakeEl(opts.pill, {
    "aria-label": opts.aria ?? `Abrir seletor de modo. No momento: ${opts.pill}`,
  });
  const sidebar = fakeEl("Modelos Gemini API");
  const items = opts.menu.map((text) => fakeEl(text));
  const section = fakeEl("Nível de raciocínio");
  const levels = [
    "Mín. Rápido e eficiente",
    "Médio Aprofundamento equilibrado",
    "Máx. Muito detalhado",
  ].map((text) => fakeEl(text, { "aria-checked": "false" }));
  let submenuOpen = false;
  const menuEntries = () => [
    ...items,
    ...(opts.reasoning ? [section] : []),
    ...(opts.reasoning && submenuOpen ? levels : []),
  ];

  const doc = {
    querySelectorAll(selector: string): FakeEl[] {
      if (selector.startsWith("[data-omni-gweb-picker]")) {
        return [pill].filter((e) => "data-omni-gweb-picker" in e.attrs);
      }
      if (selector.startsWith("[data-omni-gweb-item]")) {
        return menuEntries().filter((e) => "data-omni-gweb-item" in e.attrs);
      }
      if (selector.startsWith("button")) {
        return opts.noPicker ? [sidebar] : [sidebar, pill];
      }
      if (selector.includes("menuitem")) return open ? menuEntries() : [];
      return [];
    },
    querySelector(selector: string): FakeEl | null {
      const m = /^\[([^\]]+)\]$/.exec(selector);
      const attr = m?.[1];
      return attr ? (menuEntries().find((e) => attr in e.attrs) ?? null) : null;
    },
  };

  const page = {
    // Same contract as Playwright (Node): a string is an EXPRESSION, evaluated as is. It is not
    // called with an argument — a bare `(a) => …` would just come back as a function.
    async evaluate<R>(expression: string): Promise<R> {
      state.expressions.push(expression);
      return vm.runInNewContext(expression, { document: doc }) as R;
    },
    async waitForTimeout() {},
    locator(selector: string) {
      return {
        first: () => ({
          async click() {
            if (selector.includes("data-omni-gweb-picker")) {
              open = !open;
              state.menuOpened++;
              state.clicks.push("pill");
              return;
            }
            const tagged = menuEntries().find((e) => "data-omni-gweb-item" in e.attrs);
            state.clicks.push(`item:${tagged?.innerText ?? "?"}`);
            if (tagged === section) {
              submenuOpen = true;
              return;
            }
            if (tagged && levels.includes(tagged)) {
              if (opts.levelsApply === false) {
                // A click that did nothing: the menu stays open and nothing becomes checked.
                return;
              }
              levels.forEach((l) => (l.attrs["aria-checked"] = l === tagged ? "true" : "false"));
              state.level = tagged.innerText.split(" ")[0];
              submenuOpen = false;
              open = false;
              return;
            }
            if (tagged && opts.applies !== false) {
              const name = tagged.innerText.replace(/\s+(Respostas|Ajuda|Racioc|Tarefas).*$/, "");
              state.pill = SHORT_PILL[name] ?? name;
              pill.innerText = state.pill;
              pill.attrs["aria-label"] = `Abrir seletor de modo. No momento: ${state.pill}`;
            }
            open = false;
          },
        }),
      };
    },
  };
  return { page, state };
}

const MENU = [
  "3.5 Flash Lite Respostas mais rápidas",
  "3.8 Flash Ajuda para tudo",
  "3.1 Pro Raciocínio avançado",
  "4 Argon Tarefas complexas Novo",
];

test("picker: nothing is clicked when the requested model is already shown", async () => {
  const { page, state } = makeFakePickerPage({ pill: "Argon", menu: MENU });
  await selectGeminiWebModel(page, findGeminiWebModel("gemini-4-argon")!);
  assert.deepEqual(state.clicks, []);
});

test("picker: selects the requested model from the open menu", async () => {
  const { page, state } = makeFakePickerPage({ pill: "Argon", menu: MENU });
  await selectGeminiWebModel(page, findGeminiWebModel("gemini-3.8-flash")!);
  assert.deepEqual(state.clicks, ["pill", "item:3.8 Flash Ajuda para tudo"]);
  assert.equal(state.pill, "Flash", "the button shows the short name, not the menu's");
});

test("picker: page scripts are sent as self-invoking expressions (Playwright never calls a string)", async () => {
  const { page, state } = makeFakePickerPage({ pill: "Argon", menu: MENU, reasoning: true });
  await selectGeminiWebModel(page, findGeminiWebModel("gemini-3.8-flash")!);
  await selectGeminiWebReasoning(page, "max");
  assert.ok(state.expressions.length >= 4);
  for (const expression of state.expressions) {
    assert.match(expression, /^\(\(.*\)\(.*\)$/s, "must be (script)(arg)");
    // Evaluated on its own it must yield a VALUE, not a function.
    const value = vm.runInNewContext(expression, {
      document: { querySelectorAll: () => [], querySelector: () => null },
    });
    assert.notEqual(typeof value, "function");
  }
});

test("picker: 'Flash' and 'Flash-Lite' buttons are different models", async () => {
  // Wanting 3.8 Flash while the button reads "Flash-Lite" must click, not skip.
  const wantFlash = makeFakePickerPage({ pill: "Flash-Lite", menu: MENU });
  await selectGeminiWebModel(wantFlash.page, findGeminiWebModel("gemini-3.8-flash")!);
  assert.deepEqual(wantFlash.state.clicks, ["pill", "item:3.8 Flash Ajuda para tudo"]);
  assert.equal(wantFlash.state.pill, "Flash");

  // And already showing the right short name means no click at all.
  const already = makeFakePickerPage({ pill: "Flash-Lite", menu: MENU });
  await selectGeminiWebModel(already.page, findGeminiWebModel("gemini-3.5-flash-lite-low")!);
  assert.deepEqual(already.state.clicks, []);
});

test("picker: the button is found by aria-label even when its text is an ambiguous short word", async () => {
  const { page, state } = makeFakePickerPage({
    pill: "Pro",
    aria: "Abrir seletor de modo. No momento: Pro",
    menu: MENU,
  });
  await selectGeminiWebModel(page, findGeminiWebModel("gemini-3.1-pro-high")!);
  assert.deepEqual(state.clicks, [], "already on Pro");
});

test("picker: Argon is satisfied by the short pill label", async () => {
  const { page, state } = makeFakePickerPage({ pill: "Pro", menu: MENU });
  await selectGeminiWebModel(page, findGeminiWebModel("gemini-4-argon")!);
  assert.equal(state.pill, "Argon");
});

test("picker: a model the account's menu does not offer is a 404, not a silent default", async () => {
  const { page } = makeFakePickerPage({
    pill: "Flash",
    menu: ["3.5 Flash Lite Respostas mais rápidas", "3.8 Flash Ajuda para tudo"],
  });
  await assert.rejects(
    selectGeminiWebModel(page, findGeminiWebModel("gemini-3.1-pro")!),
    (err: unknown) => err instanceof GeminiWebModelSelectionError && err.status === 404
  );
});

test("picker: '3.8 Flash' never selects a '3.8 Flash Lite' entry", async () => {
  const { page } = makeFakePickerPage({
    pill: "4 Argon",
    aria: "Abrir seletor de modo. No momento: Argon",
    menu: ["3.8 Flash Lite Respostas mais rápidas"],
  });
  await assert.rejects(
    selectGeminiWebModel(page, findGeminiWebModel("gemini-3.8-flash")!),
    (err: unknown) => err instanceof GeminiWebModelSelectionError && err.status === 404
  );
});

test("picker: a missing picker is a 502 that names the cause", async () => {
  const { page } = makeFakePickerPage({ pill: "x", menu: MENU, noPicker: true });
  await assert.rejects(
    selectGeminiWebModel(page, findGeminiWebModel("gemini-3.1-pro")!, 300),
    (err: unknown) =>
      err instanceof GeminiWebModelSelectionError &&
      err.status === 502 &&
      /picker was not found/i.test(err.message)
  );
});

test("picker: a click that does not change the picker is reported, not trusted", async () => {
  const { page } = makeFakePickerPage({ pill: "Argon", menu: MENU, applies: false });
  await assert.rejects(
    selectGeminiWebModel(page, findGeminiWebModel("gemini-3.1-pro")!),
    (err: unknown) =>
      err instanceof GeminiWebModelSelectionError &&
      err.status === 502 &&
      /did not take effect/i.test(err.message)
  );
});

test("picker: menu entry pattern is anchored and Lite-aware", () => {
  const flash = new RegExp(geminiWebMenuItemPattern(findGeminiWebModel("gemini-3.8-flash")!));
  assert.ok(flash.test("3.8 Flash Ajuda para tudo"));
  assert.ok(!flash.test("3.8 Flash Lite Respostas mais rápidas"));
  assert.ok(!flash.test("Modelo 3.8 Flash"));
  const lite = new RegExp(geminiWebMenuItemPattern(findGeminiWebModel("gemini-3.5-flash-lite")!));
  assert.ok(lite.test("3.5 Flash Lite Respostas mais rápidas"));
  const pro = new RegExp(geminiWebMenuItemPattern(findGeminiWebModel("gemini-3.1-pro")!));
  assert.ok(pro.test("3.1 Pro Raciocínio avançado"));
  assert.ok(!pro.test("3.15 Pro"));
});

test("reasoning: OpenAI efforts map onto the three levels, unknown values are ignored", () => {
  assert.equal(resolveGeminiWebReasoning("low"), "min");
  assert.equal(resolveGeminiWebReasoning("minimal"), "min");
  assert.equal(resolveGeminiWebReasoning("MEDIUM"), "medium");
  assert.equal(resolveGeminiWebReasoning("high"), "max");
  assert.equal(resolveGeminiWebReasoning("xhigh"), "max");
  assert.equal(resolveGeminiWebReasoning("turbo"), null);
  assert.equal(resolveGeminiWebReasoning(undefined), null);
  assert.equal(resolveGeminiWebReasoning(3), null);
});

test("reasoning: opens the menu, enters the section and picks the level", async () => {
  const { page, state } = makeFakePickerPage({ pill: "Argon", menu: MENU, reasoning: true });
  await selectGeminiWebReasoning(page, "max");
  assert.deepEqual(state.clicks, ["pill", "item:Nível de raciocínio", "item:Máx. Muito detalhado"]);
  assert.equal(state.level, "Máx.");
});

test("reasoning: picks Mín and Médio by their own entries", async () => {
  for (const [level, first] of [
    ["min", "Mín."],
    ["medium", "Médio"],
  ] as const) {
    const { page, state } = makeFakePickerPage({ pill: "Argon", menu: MENU, reasoning: true });
    await selectGeminiWebReasoning(page, level);
    assert.equal(state.level, first);
  }
});

test("reasoning: a page without the control is a 502, not a silent default", async () => {
  const { page } = makeFakePickerPage({ pill: "Argon", menu: MENU, reasoning: false });
  await assert.rejects(
    selectGeminiWebReasoning(page, "max", 300),
    (err: unknown) =>
      err instanceof GeminiWebModelSelectionError &&
      err.status === 502 &&
      /reasoning-level control was not found/i.test(err.message)
  );
});

test("reasoning: a level that stays unchecked is reported", async () => {
  const { page } = makeFakePickerPage({
    pill: "Argon",
    menu: MENU,
    reasoning: true,
    levelsApply: false,
  });
  await assert.rejects(
    selectGeminiWebReasoning(page, "medium"),
    (err: unknown) =>
      err instanceof GeminiWebModelSelectionError && /did not take effect/i.test(err.message)
  );
});

test("challenge URL detection", () => {
  assert.equal(
    isGoogleChallengeUrl(
      "https://www.google.com/sorry/index?continue=https://gemini.google.com/app"
    ),
    true
  );
  assert.equal(isGoogleChallengeUrl("https://gemini.google.com/app"), false);
  assert.equal(isGoogleChallengeUrl("https://example.com/sorry/"), false);
});

// ─── Executor integration (fake Chromium) ───────────────────────────────────

function makeStreamGenerateBody(text: string): string {
  const inner = new Array(80).fill(null);
  inner[4] = [[null, [text]]];
  return `)]}'\n10\n[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
}

interface FakeBrowserOptions extends FakePickerOptions {
  /** URL the page reports after navigation. */
  url?: string;
  /** Status of the StreamGenerate response. */
  streamStatus?: number;
  answer?: string;
}

async function withFakeChromium<T>(
  opts: FakeBrowserOptions,
  run: (probe: {
    launches: number;
    clicks: string[];
    typed: string[];
    picker: { level: string | null; pill: string };
  }) => Promise<T>
): Promise<T> {
  const playwright = await import("playwright");
  const original = playwright.chromium.launch;
  const { page: picker, state } = makeFakePickerPage(opts);
  const probe = {
    launches: 0,
    clicks: state.clicks,
    typed: [] as string[],
    get picker() {
      return state;
    },
  };
  let onResponse: ((resp: unknown) => Promise<void>) | null = null;

  const page = {
    ...picker,
    on(event: string, handler: (resp: unknown) => Promise<void>) {
      if (event === "response") onResponse = handler;
    },
    async goto() {
      return { status: () => 200 };
    },
    url: () => opts.url ?? "https://gemini.google.com/app",
    async waitForSelector() {
      return { click: async () => {} };
    },
    keyboard: {
      async type(text: string) {
        probe.typed.push(text);
      },
      async press(key: string) {
        if (key !== "Enter" || !onResponse) return;
        await onResponse({
          url: () => "https://gemini.google.com/_/BardChatUi/data/StreamGenerate",
          status: () => opts.streamStatus ?? 200,
          text: async () => makeStreamGenerateBody(opts.answer ?? "olá do Argon"),
        });
      },
    },
  };

  playwright.chromium.launch = (async () => {
    probe.launches++;
    return {
      newContext: async () => ({ addCookies: async () => {}, newPage: async () => page }),
      close: async () => {},
    };
  }) as never;

  try {
    return await run(probe);
  } finally {
    playwright.chromium.launch = original;
  }
}

function newGate(overrides: Record<string, unknown> = {}) {
  const gate = new GeminiWebGate({ ...FAST, ...overrides });
  __setGeminiWebGateForTests(gate);
  return gate;
}

async function chat(
  model: string,
  cookie = "__Secure-1PSID=exec-test-psid",
  extra: Record<string, unknown> = {}
) {
  return new GeminiWebExecutor().execute({
    model,
    body: { messages: [{ role: "user", content: "oi" }], stream: false, ...extra },
    stream: false,
    credentials: { apiKey: cookie },
    signal: AbortSignal.timeout(10_000),
    log: null,
  });
}

test("executor: selects the requested model, answers, echoes the id and frees the gate", async () => {
  const gate = newGate();
  try {
    await withFakeChromium({ pill: "Pro", menu: MENU }, async (probe) => {
      const result = await chat("gemini-4-argon");
      assert.equal(result.response.status, 200);
      const json = (await result.response.json()) as {
        model: string;
        choices: Array<{ message: { content: string } }>;
      };
      assert.equal(json.model, "gemini-4-argon");
      assert.equal(json.choices[0].message.content, "olá do Argon");
      assert.deepEqual(probe.typed, ["oi"]);
      assert.equal(probe.launches, 1);
    });
    assert.equal(gate.stats().pending, 0, "the permit must be released after the browser closes");
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: reasoning_effort sets the level after the model; no effort leaves it alone", async () => {
  const gate = newGate();
  try {
    await withFakeChromium({ pill: "Pro", menu: MENU, reasoning: true }, async (probe) => {
      const withEffort = await chat("gemini-4-argon", "__Secure-1PSID=reasoning-test", {
        reasoning_effort: "high",
      });
      assert.equal(withEffort.response.status, 200);
      assert.deepEqual(probe.typed, ["oi"]);
      assert.equal(probe.picker.pill, "Argon", "model is selected first");
      assert.equal(probe.picker.level, "Máx.", "then the level");
      assert.ok(
        probe.clicks.indexOf("item:4 Argon Tarefas complexas Novo") <
          probe.clicks.indexOf("item:Nível de raciocínio")
      );
    });
    assert.equal(gate.stats().pending, 0);
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: a tier id selects model AND level with no extra parameter", async () => {
  const gate = newGate();
  try {
    await withFakeChromium({ pill: "Pro", menu: MENU, reasoning: true }, async (probe) => {
      const result = await chat("gemini-4-argon-high", "__Secure-1PSID=tier-high");
      assert.equal(result.response.status, 200);
      const json = (await result.response.json()) as { model: string };
      assert.equal(json.model, "gemini-4-argon-high", "the requested id is echoed");
      assert.equal(probe.picker.pill, "Argon");
      assert.equal(probe.picker.level, "Máx.");
    });
    await withFakeChromium({ pill: "Argon", menu: MENU, reasoning: true }, async (probe) => {
      await chat("gemini-4-argon-low", "__Secure-1PSID=tier-low");
      assert.equal(probe.picker.level, "Mín.");
    });
    await withFakeChromium({ pill: "Argon", menu: MENU, reasoning: true }, async (probe) => {
      await chat("gemini-4-argon-medium", "__Secure-1PSID=tier-medium");
      assert.equal(probe.picker.level, "Médio");
    });
    assert.equal(gate.stats().pending, 0);
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: the tier in the id wins over a conflicting reasoning_effort", async () => {
  newGate();
  try {
    await withFakeChromium({ pill: "Argon", menu: MENU, reasoning: true }, async (probe) => {
      await chat("gemini-4-argon-low", "__Secure-1PSID=tier-wins", { reasoning_effort: "high" });
      assert.equal(probe.picker.level, "Mín.");
    });
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: a bare base id still works and obeys reasoning_effort", async () => {
  newGate();
  try {
    await withFakeChromium({ pill: "Argon", menu: MENU, reasoning: true }, async (probe) => {
      const result = await chat("gemini-4-argon", "__Secure-1PSID=bare", {
        reasoning_effort: "medium",
      });
      assert.equal(result.response.status, 200);
      assert.equal(probe.picker.level, "Médio");
    });
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: without reasoning_effort the level section is never touched", async () => {
  newGate();
  try {
    await withFakeChromium({ pill: "Argon", menu: MENU, reasoning: true }, async (probe) => {
      const result = await chat("gemini-4-argon", "__Secure-1PSID=no-effort-test");
      assert.equal(result.response.status, 200);
      assert.equal(probe.picker.level, null);
      assert.ok(!probe.clicks.some((c) => c.includes("Nível")), "level section untouched");
    });
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: an unknown model is a 400 and never launches a browser", async () => {
  const gate = newGate();
  try {
    await withFakeChromium({ pill: "Argon", menu: MENU }, async (probe) => {
      const result = await chat("gemini-3.5-flash");
      assert.equal(result.response.status, 400);
      const json = (await result.response.json()) as { error: string };
      assert.match(json.error, /Unknown Gemini Web model/);
      assert.match(json.error, /gemini-4-argon/);
      assert.equal(probe.launches, 0);
    });
    assert.equal(gate.stats().pending, 0);
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: a model the account does not offer fails (404) and nothing is typed", async () => {
  const gate = newGate();
  try {
    await withFakeChromium(
      { pill: "Flash", menu: ["3.8 Flash Ajuda para tudo"] },
      async (probe) => {
        const result = await chat("gemini-3.1-pro");
        assert.equal(result.response.status, 404);
        assert.deepEqual(probe.typed, [], "must not ask a different model");
      }
    );
    assert.equal(gate.stats().pending, 0, "the permit is released on a selection failure too");
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: a Google challenge page trips the cooldown and the next request never launches", async () => {
  const gate = newGate({ challengeCooldownMs: 60_000 });
  try {
    await withFakeChromium(
      {
        pill: "Argon",
        menu: MENU,
        url: "https://www.google.com/sorry/index?continue=https://gemini.google.com/app",
      },
      async (probe) => {
        const first = await chat("gemini-4-argon");
        assert.equal(first.response.status, 429);
        assert.ok(Number(first.response.headers.get("Retry-After")) >= 1);
        assert.deepEqual(probe.typed, [], "never type into a captcha page");
        assert.equal(probe.launches, 1);
        assert.ok(gate.challengeRemainingMs() > 0);

        const second = await chat("gemini-4-argon");
        assert.equal(second.response.status, 429);
        assert.equal(probe.launches, 1, "the cooldown must stop new browsers");
      }
    );
    assert.equal(gate.stats().pending, 0);
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: HTTP 429 on StreamGenerate trips the cooldown", async () => {
  const gate = newGate({ challengeCooldownMs: 60_000 });
  try {
    await withFakeChromium({ pill: "Argon", menu: MENU, streamStatus: 429 }, async () => {
      const result = await chat("gemini-4-argon");
      assert.equal(result.response.status, 429);
      assert.ok(gate.challengeRemainingMs() > 0);
    });
  } finally {
    __setGeminiWebGateForTests(null);
  }
});

test("executor: a saturated gate answers 429 + Retry-After before any browser", async () => {
  newGate({ window: { requests: 1, windowMs: 60_000 } });
  try {
    await withFakeChromium({ pill: "Argon", menu: MENU }, async (probe) => {
      const ok = await chat("gemini-4-argon", "__Secure-1PSID=window-test");
      assert.equal(ok.response.status, 200);
      const blocked = await chat("gemini-4-argon", "__Secure-1PSID=window-test");
      assert.equal(blocked.response.status, 429);
      assert.ok(Number(blocked.response.headers.get("Retry-After")) >= 1);
      assert.equal(probe.launches, 1);
    });
  } finally {
    __setGeminiWebGateForTests(null);
  }
});
