import test from "node:test";
import assert from "node:assert/strict";

import {
  checkClaudeCodeOnlyGate,
  CLAUDE_CODE_ONLY_MESSAGE,
} from "../../src/sse/handlers/chat/claudeCodeOnlyGate.ts";
import { isClaudeCodeOnlyEndpointSelection } from "../../src/shared/constants/endpointCategories.ts";

const claudeCodeHeaders = () =>
  new Headers({
    "user-agent": "claude-cli/2.1.292 (external, sdk-cli, agent-sdk/0.3.295)",
    "x-app": "cli",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
  });
const claudeCodeBody = () => ({
  model: "claude-sonnet-5-5",
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.292.428; cc_entrypoint=sdk-cli;" },
  ],
  metadata: { user_id: JSON.stringify({ device_id: "d".repeat(64), session_id: "s-1", account_uuid: "" }) },
  messages: [{ role: "user", content: "oi" }],
});
const scriptHeaders = () => new Headers({ "user-agent": "Anthropic/Python 0.40.0" });
const scriptBody = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 4000,
  system: "Você é professor de medicina.",
  messages: [{ role: "user", content: "questão 1" }],
});

const nativeOnlyKey = { id: "key-1", allowedEndpoints: ["chat:messages"] };

test("a Claude-Code-only key rejects a non-Claude-Code client with the 'Uso não permitido' message", () => {
  const verdict = checkClaudeCodeOnlyGate({
    apiKeyInfo: nativeOnlyKey,
    headers: scriptHeaders(),
    body: scriptBody(),
  });
  assert.equal(verdict.blocked, true);
  if (!verdict.blocked) return;
  assert.equal(verdict.message, CLAUDE_CODE_ONLY_MESSAGE);
  assert.match(verdict.message, /Uso não permitido/);
  assert.match(verdict.message, /Claude Code/);
  assert.equal(verdict.score, 0);
});

test("the same key serves the real Claude Code client", () => {
  assert.deepEqual(
    checkClaudeCodeOnlyGate({
      apiKeyInfo: nativeOnlyKey,
      headers: claudeCodeHeaders(),
      body: claudeCodeBody(),
    }),
    { blocked: false }
  );
});

test("header-only forgery on a Claude-Code-only key is still rejected", () => {
  const verdict = checkClaudeCodeOnlyGate({
    apiKeyInfo: nativeOnlyKey,
    headers: claudeCodeHeaders(),
    body: scriptBody(),
  });
  assert.equal(verdict.blocked, true);
});

test("keys WITHOUT the checkbox are untouched, whatever the client", () => {
  for (const allowedEndpoints of [["chat"], [], null, undefined, ["chat", "chat:messages"], ["models"]]) {
    assert.deepEqual(
      checkClaudeCodeOnlyGate({
        apiKeyInfo: { id: "k", allowedEndpoints: allowedEndpoints as string[] | null | undefined },
        headers: scriptHeaders(),
        body: scriptBody(),
      }),
      { blocked: false },
      `allowedEndpoints=${JSON.stringify(allowedEndpoints)} must not be gated`
    );
  }
  assert.deepEqual(
    checkClaudeCodeOnlyGate({ apiKeyInfo: null, headers: scriptHeaders(), body: scriptBody() }),
    { blocked: false }
  );
});

test("the checkbox alongside other categories is still Claude-Code-only for chat", () => {
  assert.equal(isClaudeCodeOnlyEndpointSelection(["chat:messages", "models"]), true);
  assert.equal(isClaudeCodeOnlyEndpointSelection(["chat:messages"]), true);
  assert.equal(isClaudeCodeOnlyEndpointSelection(["chat", "chat:messages"]), false);
  assert.equal(isClaudeCodeOnlyEndpointSelection(["chat:completions"]), false);
  assert.equal(isClaudeCodeOnlyEndpointSelection([]), false);
  assert.equal(isClaudeCodeOnlyEndpointSelection(null), false);
});

test("CLAUDE_CODE_SIGNATURE_GATE_OFF is the emergency off-switch", () => {
  const previous = process.env.CLAUDE_CODE_SIGNATURE_GATE_OFF;
  try {
    process.env.CLAUDE_CODE_SIGNATURE_GATE_OFF = "1";
    assert.deepEqual(
      checkClaudeCodeOnlyGate({ apiKeyInfo: nativeOnlyKey, headers: scriptHeaders(), body: scriptBody() }),
      { blocked: false }
    );
    process.env.CLAUDE_CODE_SIGNATURE_GATE_OFF = "0";
    assert.equal(
      checkClaudeCodeOnlyGate({ apiKeyInfo: nativeOnlyKey, headers: scriptHeaders(), body: scriptBody() }).blocked,
      true
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SIGNATURE_GATE_OFF;
    else process.env.CLAUDE_CODE_SIGNATURE_GATE_OFF = previous;
  }
});
