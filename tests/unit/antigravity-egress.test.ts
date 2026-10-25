// agy CLI-identity requests must leave through the Go egress (docker/agy-egress) so the
// TLS/HTTP fingerprint is Go's like the official CLI's; everything else — gemini-cli,
// the legacy ide profile, other hosts — must stay on Node's fetch untouched.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createAntigravityEgressFetch,
  getAntigravityEgressConfig,
  installAntigravityEgressFetch,
  isAntigravityCliRequest,
  resetAntigravityEgressInstallForTests,
} from "../../open-sse/services/antigravityEgress.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { seedAntigravityVersionCache } from "../../open-sse/services/antigravityVersion.ts";
import { antigravityCliUserAgent } from "../../open-sse/config/antigravityCliClient.ts";
import { runWithCapture } from "../../open-sse/utils/providerRequestLogging.ts";

const EGRESS_ENV = { ANTIGRAVITY_EGRESS_URL: "http://agy-egress:8787/" };
const CLI_UA = antigravityCliUserAgent();
const CAPTURE_STATE_KEY = Symbol.for("omniroute.providerRequestCapture.state");

type Seen = { url: string; headers: Headers; method?: string; body?: unknown };

function recorder(seen: Seen[], status = 200, body = "{}") {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      method: init?.method,
      body: init?.body,
    });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("config: off without ANTIGRAVITY_EGRESS_URL, trailing slash trimmed, token optional", () => {
  assert.equal(getAntigravityEgressConfig({}), null);
  assert.equal(getAntigravityEgressConfig({ ANTIGRAVITY_EGRESS_URL: "not a url" }), null);
  assert.equal(getAntigravityEgressConfig({ ANTIGRAVITY_EGRESS_URL: "ftp://x" }), null);
  assert.deepEqual(getAntigravityEgressConfig(EGRESS_ENV), {
    baseUrl: "http://agy-egress:8787",
    token: null,
  });
  assert.equal(
    getAntigravityEgressConfig({ ...EGRESS_ENV, ANTIGRAVITY_EGRESS_TOKEN: "secret-1234567890" })
      ?.token,
    "secret-1234567890"
  );
});

test("only requests carrying the agy CLI identity are routed", () => {
  const cloudCode = new URL("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
  const prod = new URL(
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
  );
  const oauth = new URL("https://oauth2.googleapis.com/token");
  const headers = (ua: string) => new Headers({ "User-Agent": ua });

  assert.equal(isAntigravityCliRequest(cloudCode, headers(CLI_UA)), true);
  assert.equal(isAntigravityCliRequest(prod, headers(CLI_UA)), true);
  assert.equal(isAntigravityCliRequest(oauth, headers("Go-http-client/1.1")), true);
  // gemini-cli talks to the same hosts with its own (Node) identity.
  assert.equal(isAntigravityCliRequest(prod, headers("GeminiCLI/0.30.0 (linux; x64)")), false);
  assert.equal(isAntigravityCliRequest(oauth, headers("google-api-nodejs-client/9.15.1")), false);
  // Legacy ide profile.
  assert.equal(
    isAntigravityCliRequest(
      cloudCode,
      headers("Antigravity/2.5.5 (linux; x64) Chrome/142 Electron/39")
    ),
    false
  );
  assert.equal(
    isAntigravityCliRequest(new URL("https://api.openai.com/v1/chat"), headers(CLI_UA)),
    false
  );
});

test("a routed request keeps method, body, path and query and names the Google host", async () => {
  const seen: Seen[] = [];
  const egressFetch = createAntigravityEgressFetch(recorder(seen), {
    baseUrl: "http://agy-egress:8787",
    token: "secret-1234567890",
  });
  const signal = new AbortController().signal;
  await egressFetch(
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    {
      method: "POST",
      headers: { "User-Agent": CLI_UA, Authorization: "Bearer t" },
      body: '{"request":{}}',
      signal,
    }
  );
  await egressFetch("https://api.example.com/v1/x", { headers: { "User-Agent": CLI_UA } });

  assert.equal(seen[0].url, "http://agy-egress:8787/v1internal:streamGenerateContent?alt=sse");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body, '{"request":{}}');
  assert.equal(seen[0].headers.get("x-agy-egress-host"), "daily-cloudcode-pa.googleapis.com");
  assert.equal(seen[0].headers.get("x-agy-egress-token"), "secret-1234567890");
  assert.equal(seen[0].headers.get("authorization"), "Bearer t");
  assert.equal(seen[1].url, "https://api.example.com/v1/x", "other hosts are untouched");
});

test("install: disabled without config, idempotent, refused after the capture wrapper", () => {
  const original = globalThis.fetch;
  const scoped = globalThis as typeof globalThis & {
    [CAPTURE_STATE_KEY]?: { wrappedFetch?: unknown };
  };
  const captureState = scoped[CAPTURE_STATE_KEY];
  const previousWrapped = captureState?.wrappedFetch;
  try {
    resetAntigravityEgressInstallForTests();
    assert.equal(installAntigravityEgressFetch({}), "disabled");
    assert.equal(globalThis.fetch, original);

    if (captureState) captureState.wrappedFetch = (() => {}) as unknown;
    else scoped[CAPTURE_STATE_KEY] = { wrappedFetch: () => {} };
    assert.equal(installAntigravityEgressFetch(EGRESS_ENV), "refused");
    assert.equal(globalThis.fetch, original);

    if (scoped[CAPTURE_STATE_KEY]) scoped[CAPTURE_STATE_KEY].wrappedFetch = null;
    assert.equal(installAntigravityEgressFetch(EGRESS_ENV), "installed");
    assert.notEqual(globalThis.fetch, original);
    assert.equal(installAntigravityEgressFetch(EGRESS_ENV), "already-installed");
  } finally {
    globalThis.fetch = original;
    if (scoped[CAPTURE_STATE_KEY]) scoped[CAPTURE_STATE_KEY].wrappedFetch = previousWrapped ?? null;
    resetAntigravityEgressInstallForTests();
  }
});

test("boot order: executor traffic goes cli -> egress, ide -> Google, with the capture wrapper outermost", async () => {
  const original = globalThis.fetch;
  const scoped = globalThis as typeof globalThis & {
    [CAPTURE_STATE_KEY]?: { wrappedFetch?: unknown };
  };
  const seen: Seen[] = [];
  seedAntigravityVersionCache("2026.10.25-test");
  const sse =
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}]}}\n\n';
  try {
    if (scoped[CAPTURE_STATE_KEY]) scoped[CAPTURE_STATE_KEY].wrappedFetch = null;
    resetAntigravityEgressInstallForTests();
    globalThis.fetch = recorder(seen, 200, sse);
    // Boot: egress installed before any provider request…
    assert.equal(installAntigravityEgressFetch(EGRESS_ENV), "installed");

    const run = (providerSpecificData: Record<string, unknown>) =>
      // …then the provider-request capture wraps it on the first dispatch.
      runWithCapture({ capture: async () => {} } as never, () =>
        new AntigravityExecutor().execute({
          model: "agy/gemini-3.8-flash-high",
          body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
          stream: true,
          credentials: {
            accessToken: "token",
            projectId: "aicode-consumers",
            connectionId: "conn-egress",
            providerSpecificData,
          },
          log: { debug() {}, warn() {}, info() {} },
        } as never)
      );

    const cli = await run({});
    assert.equal(cli.response.status, 200);
    const cliCall = seen.find((s) => s.url.includes("streamGenerateContent"));
    assert.ok(cliCall, "the generation call was made");
    assert.match(
      cliCall.url,
      /^http:\/\/agy-egress:8787\/v1internal:streamGenerateContent\?alt=sse$/
    );
    assert.equal(cliCall.headers.get("x-agy-egress-host"), "daily-cloudcode-pa.googleapis.com");
    assert.match(cliCall.headers.get("user-agent") ?? "", /^antigravity\/cli\//);

    seen.length = 0;
    const ide = await run({ clientProfile: "ide" });
    assert.equal(ide.response.status, 200);
    const ideCall = seen.find((s) => s.url.includes("streamGenerateContent"));
    assert.ok(ideCall);
    assert.match(
      ideCall.url,
      /^https:\/\/daily-cloudcode-pa\.googleapis\.com\//,
      "ide stays on Node"
    );
    assert.equal(ideCall.headers.get("x-agy-egress-host"), null);
  } finally {
    globalThis.fetch = original;
    if (scoped[CAPTURE_STATE_KEY]) scoped[CAPTURE_STATE_KEY].wrappedFetch = null;
    resetAntigravityEgressInstallForTests();
  }
});
