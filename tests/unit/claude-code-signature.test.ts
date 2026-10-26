import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateClaudeCodeSignature,
  CLAUDE_CODE_SIGNATURE_PASS_SCORE,
} from "../../src/shared/utils/claudeCodeSignature.ts";

// Fixtures mirror what the real client sent when captured against a fake server
// (Claude Code 2.1.292) — only the shape matters, values are synthetic.
const DEVICE_ID = "6e16430000000000000000000000000000000000000000000000000000000000";
const USER_ID_JSON = JSON.stringify({
  device_id: DEVICE_ID,
  account_uuid: "",
  session_id: "fbe1661f-67c2-417c-bc36-a114b130eeb7",
});

function claudeCodeHeaders(entrypoint = "sdk-cli, agent-sdk/0.3.295") {
  return new Headers({
    "user-agent": `claude-cli/2.1.292 (external, ${entrypoint})`,
    "x-app": "cli",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27",
    "anthropic-version": "2023-06-01",
  });
}

function claudeCodeBody(entrypoint = "sdk-cli", tools: unknown[] = [{ name: "Bash" }]) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 128000,
    stream: true,
    system: [
      { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.292.428; cc_entrypoint=${entrypoint};` },
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    metadata: { user_id: USER_ID_JSON },
    messages: [{ role: "user", content: "oi" }],
    tools,
  };
}

// What the medical-quiz script that rode a Claude-Code-only key actually sent.
const scriptHeaders = () =>
  new Headers({ "user-agent": "Anthropic/Python 0.40.0", "anthropic-version": "2023-06-01" });
const scriptBody = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 4000,
  system: "Você é professor de medicina preparando explicações. Responda SOMENTE com JSON.",
  messages: [{ role: "user", content: "questão 1" }],
});

test("real Claude Code (claude -p) passes with every signal", () => {
  const r = evaluateClaudeCodeSignature(claudeCodeHeaders(), claudeCodeBody());
  assert.equal(r.ok, true);
  assert.equal(r.score, 7);
  assert.deepEqual(r.signals, {
    billingBlock: true,
    metadataUserId: true,
    userAgent: true,
    xApp: true,
    betaHeader: true,
  });
});

test("the VS Code extension and the interactive CLI entrypoints pass too", () => {
  assert.equal(
    evaluateClaudeCodeSignature(claudeCodeHeaders("claude-vscode, agent-sdk/0.3.295"), claudeCodeBody("claude-vscode")).ok,
    true
  );
  assert.equal(evaluateClaudeCodeSignature(claudeCodeHeaders("cli"), claudeCodeBody("cli")).ok, true);
});

test("tool count is NOT a signal: --tools \"\" (0 tools) and --bare (3 tools) still pass", () => {
  assert.equal(evaluateClaudeCodeSignature(claudeCodeHeaders(), claudeCodeBody("sdk-cli", [])).ok, true);
  assert.equal(
    evaluateClaudeCodeSignature(claudeCodeHeaders(), claudeCodeBody("sdk-cli", [{}, {}, {}])).ok,
    true
  );
});

test("a version bump does not break the match (version is not pinned)", () => {
  const body = claudeCodeBody();
  (body.system[0] as { text: string }).text =
    "x-anthropic-billing-header: cc_version=9.9.999.abc; cc_entrypoint=some-new-entrypoint;";
  const headers = claudeCodeHeaders();
  headers.set("user-agent", "claude-cli/9.9.999 (external, some-new-entrypoint)");
  assert.equal(evaluateClaudeCodeSignature(headers, body).ok, true);
});

test("an SDK script (the medical-quiz generator that rode the key) is rejected", () => {
  const r = evaluateClaudeCodeSignature(scriptHeaders(), scriptBody());
  assert.equal(r.ok, false);
  assert.equal(r.score, 0);
});

test("copying only the three headers is not enough: the body must carry the client's markers", () => {
  const r = evaluateClaudeCodeSignature(claudeCodeHeaders(), scriptBody());
  assert.equal(r.score, 3);
  assert.equal(r.ok, false);
  assert.ok(r.score < CLAUDE_CODE_SIGNATURE_PASS_SCORE);
});

test("a proxy that drops every header still passes when the body is genuine (4 of 7)", () => {
  const r = evaluateClaudeCodeSignature(new Headers(), claudeCodeBody());
  assert.equal(r.score, 4);
  assert.equal(r.ok, true);
});

test("an older client without the billing block but with the legacy user_id still passes", () => {
  const body = claudeCodeBody();
  body.system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  body.metadata = {
    user_id: `user_${"a".repeat(64)}_account_${"1b2c3d4e-0000-4000-8000-000000000000"}_session_${"fbe1661f-67c2-417c-bc36-a114b130eeb7"}`,
  };
  const r = evaluateClaudeCodeSignature(claudeCodeHeaders(), body);
  assert.equal(r.signals.billingBlock, false);
  assert.equal(r.signals.metadataUserId, true);
  assert.equal(r.ok, true);
});

test("the billing block only counts as the FIRST system block", () => {
  const body = claudeCodeBody();
  body.system = [body.system[1], body.system[0]];
  assert.equal(evaluateClaudeCodeSignature(claudeCodeHeaders(), body).signals.billingBlock, false);
});

test("system given as a plain string is read too", () => {
  const body = claudeCodeBody() as Record<string, unknown>;
  body.system = "x-anthropic-billing-header: cc_version=2.1.292.428; cc_entrypoint=cli;\nYou are Claude Code";
  assert.equal(evaluateClaudeCodeSignature(null, body).signals.billingBlock, true);
});

test("a metadata.user_id that is not the client's shape does not count", () => {
  for (const user_id of [
    "",
    "someone@example.com",
    "{not json",
    JSON.stringify({ device_id: "", session_id: "x" }),
    JSON.stringify({ session_id: "only-session" }),
    JSON.stringify(["array"]),
  ]) {
    const body = { ...claudeCodeBody(), metadata: { user_id } };
    assert.equal(
      evaluateClaudeCodeSignature(null, body).signals.metadataUserId,
      false,
      `user_id ${JSON.stringify(user_id)} must not count`
    );
  }
});

test("garbage input never throws and never passes", () => {
  for (const [h, b] of [
    [null, null],
    [undefined, undefined],
    [new Headers(), 42],
    [new Headers(), "string"],
    [new Headers(), []],
    [{ get: () => { throw new Error("boom"); } }, claudeCodeBody()],
  ] as const) {
    const r = evaluateClaudeCodeSignature(h as never, b as never);
    assert.equal(typeof r.score, "number");
  }
  assert.equal(evaluateClaudeCodeSignature(null, null).ok, false);
});
