// #13381 — gemini-web advertised model IDs but never selected the requested
// model in the Gemini UI: every alias opened the identical page and ran the
// identical automation, so the OpenAI-shaped `model` field on the response was a
// caller-supplied label, not an observed fact.
//
// Fork (3.8.53 sync): upstream fixed this with gemini-web/modeSelection.ts (a 3-model
// catalog and selectors it could not validate against a live account). The fork fixed the
// same bug first with a picker measured against the real page (geminiWebPicker.ts,
// 2026-10-14) over a 12-id catalog — one id per (model, reasoning level) — and that is the
// path the executor runs. Its detailed behaviour (menu selection, read-back, disabled
// entries, signed-out pages, reasoning levels) is covered in gemini-web-gate.test.ts.
// This suite keeps #13381's invariants, end to end through the executor:
//   - an id the picker cannot select fails before any browser is spent;
//   - a page whose picker cannot be driven fails closed — the prompt is never typed under an
//     unconfirmed model label.

import test from "node:test";
import assert from "node:assert/strict";

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

type Call = { fn: string; args: unknown[] };

function makeFakePlaywright(calls: Call[]) {
  return {
    newContext: async () => ({
      addCookies: async () => {},
      cookies: async () => [],
      newPage: async () => ({
        on: () => {},
        goto: async (url: string) => {
          calls.push({ fn: "goto", args: [url] });
        },
        waitForTimeout: async () => {},
        waitForSelector: async (selector: string) => ({
          click: async () => {
            calls.push({ fn: "editor.click", args: [selector] });
          },
        }),
        // No mode picker on this page: every page script finds nothing.
        evaluate: async () => {
          calls.push({ fn: "evaluate", args: [] });
          return null;
        },
        locator: () => ({ first: () => ({ click: async () => {} }) }),
        keyboard: {
          type: async () => {},
          insertText: async (text: string) => {
            calls.push({ fn: "keyboard.insertText", args: [text] });
          },
          press: async () => {},
        },
      }),
    }),
    close: async () => {},
  };
}

async function runWithFakePage(model: string) {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const calls: Call[] = [];
  let launches = 0;
  playwright.chromium.launch = (async () => {
    launches++;
    return makeFakePlaywright(calls);
  }) as unknown as typeof originalLaunch;
  try {
    const result = await new GeminiWebExecutor().execute({
      model,
      body: { messages: [{ role: "user", content: "What is 2+2?" }], stream: false },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=fake" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });
    return { calls, launches, status: result.response.status, text: await result.response.text() };
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
}

test("#13381: an id the picker cannot select fails with 400 before any browser is launched", async () => {
  const { status, launches, text } = await runWithFakePage("gemini-4.0-ultra-does-not-exist");
  assert.equal(status, 400);
  assert.equal(launches, 0, "an unknown id must not spend a browser");
  assert.match(text, /Unknown Gemini Web model/);
});

test("#13381: a page whose picker cannot be driven fails closed, never typing the prompt", async () => {
  for (const model of ["gemini-3.8-flash-high", "gemini-3.1-pro-low"]) {
    const { status, calls, text } = await runWithFakePage(model);
    assert.notEqual(status, 200, model);
    assert.equal(status, 502, model);
    assert.ok(
      calls.some((c) => c.fn === "evaluate"),
      `${model}: the picker must have been looked for`
    );
    assert.equal(
      calls.some((c) => c.fn === "keyboard.insertText"),
      false,
      `${model}: an unconfirmed model must never receive the prompt`
    );
    assert.equal(text.includes("at /"), false, "error bodies must stay sanitized");
  }
});
