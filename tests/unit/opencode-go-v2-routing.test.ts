/**
 * OpenCode Go v2 (docs https://opencode.ai/docs/go/, 2026-10-24): every model is served under
 * `https://opencode.ai/inference/go/<format>/…`, one base per wire format, and the old
 * `https://opencode.ai/zen/go/v1` is no longer documented. The registry keeps the OpenAI base;
 * OpencodeExecutor derives the Anthropic and Google bases from it. Also covered: the Go plan asks for a
 * STABLE `x-opencode-session` per conversation, so a conversation id the client already sends is reused.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const { OpencodeExecutor, opencodeFormatBaseUrl } =
  await import("../../open-sse/executors/opencode.ts");
const { forwardOpencodeClientHeaders } = await import("../../open-sse/utils/opencodeHeaders.ts");
const { opencode_goProvider } =
  await import("../../open-sse/config/providers/registry/opencode/go/index.ts");

const OPENAI = "https://opencode.ai/inference/go/openai/v1";

function input(model: string, stream = true, credentials = { apiKey: "go-key" }) {
  return {
    model,
    stream,
    credentials,
    body: { model, stream, messages: [{ role: "user", content: "oi" }] },
  };
}

describe("opencodeFormatBaseUrl", () => {
  it("derives the Anthropic and Google bases from the inference OpenAI base", () => {
    assert.equal(
      opencodeFormatBaseUrl(OPENAI, "claude"),
      "https://opencode.ai/inference/go/anthropic/v1"
    );
    assert.equal(
      opencodeFormatBaseUrl(OPENAI, "gemini"),
      "https://opencode.ai/inference/go/google/v1beta"
    );
    assert.equal(opencodeFormatBaseUrl(OPENAI, "openai"), OPENAI);
    assert.equal(opencodeFormatBaseUrl(OPENAI, "openai-responses"), OPENAI);
    assert.equal(opencodeFormatBaseUrl(OPENAI + "/", null), OPENAI);
  });

  it("leaves every other base untouched (Zen, legacy zen/go, custom)", () => {
    for (const base of [
      "https://opencode.ai/zen/v1",
      "https://opencode.ai/zen/go/v1",
      "https://example.com/v1",
    ]) {
      assert.equal(opencodeFormatBaseUrl(base, "claude"), base);
      assert.equal(opencodeFormatBaseUrl(base, "gemini"), base);
    }
  });
});

describe("OpencodeExecutor routes OpenCode Go v2 models by their documented format", () => {
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, options: RequestInit) => {
      calls.push({ url: String(url), headers: options.headers as Record<string, string> });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("chat completions models use the OpenAI base with Bearer auth", async () => {
    const result = await new OpencodeExecutor("opencode-go").execute(input("glm-5.3-flash"));
    assert.equal(result.url, `${OPENAI}/chat/completions`);
    assert.equal(calls[0].headers.Authorization, "Bearer go-key");
  });

  it("responses-only models (gpt-6-luna) use /responses on the OpenAI base", async () => {
    const result = await new OpencodeExecutor("opencode-go").execute(input("gpt-6-luna"));
    assert.equal(result.url, `${OPENAI}/responses`);
  });

  it("Anthropic-format models use /anthropic/v1/messages with x-api-key", async () => {
    const result = await new OpencodeExecutor("opencode-go").execute(input("claude-haiku-5-5"));
    assert.equal(result.url, "https://opencode.ai/inference/go/anthropic/v1/messages");
    assert.equal(calls[0].headers["x-api-key"], "go-key");
    assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  it("ids the live list still serves outside the catalog keep their own protocol", async () => {
    // Measured 2026-10-24: on chat completions both answer 400 ModelProtocolUnsupported.
    const executor = new OpencodeExecutor("opencode-go");
    assert.equal((await executor.execute(input("grok-4.6"))).url, `${OPENAI}/responses`);
    assert.equal(
      (await executor.execute(input("minimax-m2.7"))).url,
      "https://opencode.ai/inference/go/anthropic/v1/messages"
    );
  });

  it("the Google-format model uses /google/v1beta generateContent with x-goog-api-key", async () => {
    const result = await new OpencodeExecutor("opencode-go").execute(
      input("gemini-4-argon-contributor", false)
    );
    assert.equal(
      result.url,
      "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent"
    );
    assert.equal(calls[0].headers["x-goog-api-key"], "go-key");
  });
});

describe("OpenCode Go v2 always sends x-opencode-session (400 MissingSessionID without it)", () => {
  let calls: Array<{ headers: Record<string, string> }>;
  let originalFetch: typeof fetch;
  const session = (index: number) => calls[index].headers["x-opencode-session"];

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, options: RequestInit) => {
      calls.push({ headers: options.headers as Record<string, string> });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function turn(model: string, messages: Array<{ role: string; content: string }>) {
    return { ...input(model), body: { model, stream: true, messages } };
  }

  it("a client that sends no conversation id gets one session per conversation", async () => {
    const executor = new OpencodeExecutor("opencode-go");
    const first = [{ role: "user", content: "refatore o parser" }];
    await executor.execute(turn("glm-5.3-flash", first));
    await executor.execute(
      turn("glm-5.3-flash", [
        ...first,
        { role: "assistant", content: "feito" },
        { role: "user", content: "agora os testes" },
      ])
    );
    await executor.execute(turn("glm-5.3-flash", [{ role: "user", content: "outra conversa" }]));

    assert.match(session(0), /^ses_[0-9a-f]{26}$/);
    assert.equal(session(1), session(0), "a later turn of the same conversation keeps the session");
    assert.notEqual(session(2), session(0), "a different conversation gets its own session");
  });

  // 3.8.53 sync: upstream's CLI-identity synthesis (on by default since #5997 follow-ups) renders
  // every session in the canonical `ses_` shape, translating a client id deterministically — so the
  // client's conversation still maps to ONE upstream session, it just is not forwarded verbatim.
  it("the client's own conversation id wins over the derived one", async () => {
    const executor = new OpencodeExecutor("opencode-go");
    const withClientId = {
      ...input("glm-5.3-flash"),
      clientHeaders: { "x-claude-code-session-id": "cc-123" },
    };
    await executor.execute(withClientId);
    await executor.execute(withClientId);
    await executor.execute(input("glm-5.3-flash"));
    assert.match(session(0), /^ses_/);
    assert.equal(session(1), session(0), "the same client conversation keeps one session");
    assert.notEqual(session(2), session(0), "the client id, not the body, decided the session");
  });

  it("covers the Anthropic and Google formats too", async () => {
    const executor = new OpencodeExecutor("opencode-go");
    await executor.execute(input("claude-haiku-5-5"));
    await executor.execute({
      ...input("gemini-4-argon-contributor", false),
      body: { contents: [{ role: "user", parts: [{ text: "oi" }] }] },
    });
    assert.match(session(0), /^ses_/);
    assert.match(session(1), /^ses_/);
  });

  // 3.8.53 sync: Zen now gets a canonical session from upstream's default CLI-identity synthesis
  // (opencode.ai flags requests without one since 2026-09-06); the Go-only fallback is not what
  // adds it, so with that synthesis switched off Zen still gets none.
  it("leaves OpenCode Zen to upstream's CLI-identity policy (no Go fallback there)", async () => {
    const previous = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
    process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = "false";
    try {
      await new OpencodeExecutor("opencode-zen").execute(input("big-pickle"));
      await new OpencodeExecutor("opencode-go").execute(input("glm-5.3-flash"));
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
      else process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = previous;
    }
    assert.equal(session(0), undefined);
    assert.match(session(1), /^ses_[0-9a-f]{26}$/, "Go still always carries a session");
  });
});

describe("OpenCode Go v2 catalog", () => {
  const ids = (opencode_goProvider.models ?? []).map((model) => model.id);

  it("points at the documented inference endpoints", () => {
    assert.equal(opencode_goProvider.baseUrl, OPENAI);
    assert.equal(opencode_goProvider.modelsUrl, "https://opencode.ai/inference/go/v1/models");
  });

  it("lists the documented models and none of the retired ones", () => {
    for (const id of [
      "glm-5.3-flash",
      "glm-5.3",
      "kimi-k3",
      "kimi-k3.1-pro",
      "deepseek-v4.1-flash",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "minimax-m3.1-flash",
      "claude-haiku-5-5",
      "gpt-6-luna",
      "grok-4.7",
      "qwen3.8-max",
      "gemini-4-argon-contributor",
    ]) {
      assert.ok(ids.includes(id), `${id} should be listed`);
    }
    for (const retired of [
      "glm-5.1",
      "glm-5",
      "kimi-k2.6",
      "kimi-k2.5",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "hy3-preview",
      "deepseek-v4-flash",
    ]) {
      assert.ok(!ids.includes(retired), `${retired} is no longer served by OpenCode Go`);
    }
  });
});

describe("stable x-opencode-session", () => {
  it("reuses the Claude Code session id when the client sends no x-opencode-session", () => {
    const headers: Record<string, string> = {};
    forwardOpencodeClientHeaders(
      headers,
      { "x-claude-code-session-id": "cc-123" },
      { synthesizeRequestId: true }
    );
    assert.equal(headers["x-opencode-session"], "cc-123");
    assert.ok(headers["x-opencode-request"], "a request id accompanies the reused session");
  });

  it("an explicit x-opencode-session from the client always wins", () => {
    const headers: Record<string, string> = {};
    forwardOpencodeClientHeaders(
      headers,
      { "x-opencode-session": "ses_client", "x-claude-code-session-id": "cc-123" },
      { synthesizeRequestId: true }
    );
    assert.equal(headers["x-opencode-session"], "ses_client");
  });

  it("ignores an empty or oversized session value", () => {
    const headers: Record<string, string> = {};
    forwardOpencodeClientHeaders(
      headers,
      { "x-session-id": "", thread_id: "x".repeat(300) },
      { synthesizeRequestId: true }
    );
    assert.equal(headers["x-opencode-session"], undefined);
  });
});
