/**
 * Codex client signature + "Codex only" key gate.
 *
 * The positive fixture mirrors what codex 0.162 (`codex exec`) actually sent to a
 * local listener on 2026-11-16 (ids replaced) and what real customer traffic
 * carries in `client_metadata`. The negatives are what a script, a bot or a key
 * lent to another tool look like.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_SIGNATURE_PASS_SCORE,
  evaluateCodexClientSignature,
} from "../../src/shared/utils/codexClientSignature";
import { isCodexOnlyEndpointSelection } from "../../src/shared/constants/endpointCategories";
import {
  CODEX_ONLY_MESSAGE,
  checkCodexOnlyGate,
  codexGateMode,
  describeCodexGateObservation,
} from "../../src/sse/handlers/chat/codexOnlyGate";

const TURN = JSON.stringify({
  installation_id: "00000000-0000-4000-8000-000000000001",
  session_id: "01a1e5bc-0000-7000-8000-000000000002",
  thread_id: "01a1e5bc-0000-7000-8000-000000000002",
});

function codexHeaders(originator = "codex_exec", version = "0.162.0-alpha.17.2") {
  return new Headers({
    originator,
    "user-agent": `${originator}/${version} (Ubuntu 24.4.0; x86_64) xterm-256color (${originator}; ${version})`,
    "session-id": "01a1e5bc-0000-7000-8000-000000000002",
    "thread-id": "01a1e5bc-0000-7000-8000-000000000002",
    "x-codex-window-id": "01a1e5bc-0000-7000-8000-000000000002:0",
    "x-codex-turn-metadata": TURN,
  });
}

const CODEX_BODY = {
  model: "gpt-6-luna",
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "01a1e5bc-0000-7000-8000-000000000002",
  client_metadata: {
    turn_id: "01a1e5bc-0000-7000-8000-000000000003",
    "x-codex-installation-id": "00000000-0000-4000-8000-000000000001",
    "x-codex-turn-metadata": TURN,
    session_id: "01a1e5bc-0000-7000-8000-000000000002",
  },
  input: [{ role: "user", content: [{ type: "input_text", text: "ok" }] }],
};

const SCRIPT_BODY = { model: "gpt-6-luna", input: "ok", stream: false };
const SCRIPT_HEADERS = new Headers({ "user-agent": "OpenAI/Python 1.99.0" });

test("the real codex exec request scores 7/7 and passes", () => {
  const r = evaluateCodexClientSignature(codexHeaders(), CODEX_BODY);
  assert.equal(r.score, 7);
  assert.equal(r.ok, true);
  assert.equal(r.originator, "codex_exec");
  assert.equal(r.userAgentProduct, "codex_exec/0.162.0-alpha.17.2");
});

for (const originator of ["codex_cli_rs", "codex_vscode", "codex_desktop"]) {
  test(`other official originators pass too (${originator})`, () => {
    assert.equal(evaluateCodexClientSignature(codexHeaders(originator), CODEX_BODY).ok, true);
  });
}

test("an OpenAI SDK script scores 0 and fails", () => {
  const r = evaluateCodexClientSignature(SCRIPT_HEADERS, SCRIPT_BODY);
  assert.equal(r.score, 0);
  assert.equal(r.ok, false);
});

test("header-only forgery (originator + UA + session headers, plain body) fails at 3", () => {
  const forged = new Headers({
    originator: "codex_exec",
    "user-agent": "codex_exec/0.162.0 (Linux; x86_64)",
    "session-id": "abc",
  });
  const r = evaluateCodexClientSignature(forged, SCRIPT_BODY);
  assert.equal(r.score, 3);
  assert.ok(r.score < CODEX_SIGNATURE_PASS_SCORE);
  assert.equal(r.ok, false);
});

test("a genuine Codex body behind a proxy that dropped every header still passes (4)", () => {
  const r = evaluateCodexClientSignature(new Headers(), CODEX_BODY);
  assert.equal(r.score, 4);
  assert.equal(r.ok, true);
});

test("garbage turn metadata does not count", () => {
  const body = {
    ...CODEX_BODY,
    client_metadata: { "x-codex-installation-id": "x", "x-codex-turn-metadata": "{not json" },
  };
  const r = evaluateCodexClientSignature(new Headers(), body);
  assert.equal(r.signals.turnMetadata, false);
  assert.equal(r.score, 2);
});

test("never throws on odd input", () => {
  assert.equal(evaluateCodexClientSignature(null, null).score, 0);
  assert.equal(evaluateCodexClientSignature(undefined, "text").score, 0);
  assert.equal(evaluateCodexClientSignature(new Headers(), [1, 2]).score, 0);
});

test("Codex-only selection = chat:responses without the whole chat category", () => {
  assert.equal(isCodexOnlyEndpointSelection(["chat:responses"]), true);
  assert.equal(isCodexOnlyEndpointSelection(["chat:responses", "embeddings"]), true);
  assert.equal(isCodexOnlyEndpointSelection(["chat", "chat:responses"]), false);
  assert.equal(isCodexOnlyEndpointSelection(["chat:messages"]), false);
  assert.equal(isCodexOnlyEndpointSelection([]), false);
  assert.equal(isCodexOnlyEndpointSelection(null), false);
});

const CODEX_ONLY_KEY = {
  id: "key-codex",
  name: "client codex",
  allowedEndpoints: ["chat:responses"],
};
const OPEN_KEY = { id: "key-open", name: "open", allowedEndpoints: [] as string[] };

test("observe mode never blocks, but flags what enforce would refuse", () => {
  const v = checkCodexOnlyGate({
    apiKeyInfo: CODEX_ONLY_KEY,
    headers: SCRIPT_HEADERS,
    body: SCRIPT_BODY,
    mode: "observe",
  });
  assert.equal(v.blocked, false);
  assert.equal(v.observation?.wouldBlock, true);
  assert.equal(v.observation?.codexOnlyKey, true);
});

test("enforce mode refuses a script on a Codex-only key", () => {
  const v = checkCodexOnlyGate({
    apiKeyInfo: CODEX_ONLY_KEY,
    headers: SCRIPT_HEADERS,
    body: SCRIPT_BODY,
    mode: "enforce",
  });
  assert.equal(v.blocked, true);
  if (v.blocked) assert.equal(v.message, CODEX_ONLY_MESSAGE);
});

test("enforce mode lets the real Codex client through on a Codex-only key", () => {
  const v = checkCodexOnlyGate({
    apiKeyInfo: CODEX_ONLY_KEY,
    headers: codexHeaders(),
    body: CODEX_BODY,
    mode: "enforce",
  });
  assert.equal(v.blocked, false);
  assert.equal(v.observation?.wouldBlock, false);
});

test("enforce mode leaves keys that are not Codex-only alone", () => {
  const v = checkCodexOnlyGate({
    apiKeyInfo: OPEN_KEY,
    headers: SCRIPT_HEADERS,
    body: SCRIPT_BODY,
    mode: "enforce",
  });
  assert.equal(v.blocked, false);
  assert.equal(v.observation?.codexOnlyKey, false);
});

test("off mode evaluates nothing", () => {
  const v = checkCodexOnlyGate({
    apiKeyInfo: CODEX_ONLY_KEY,
    headers: SCRIPT_HEADERS,
    body: SCRIPT_BODY,
    mode: "off",
  });
  assert.deepEqual(v, { blocked: false, observation: null });
});

test("mode comes from CODEX_CLIENT_GATE_MODE and defaults to observe", () => {
  const saved = process.env.CODEX_CLIENT_GATE_MODE;
  try {
    delete process.env.CODEX_CLIENT_GATE_MODE;
    assert.equal(codexGateMode(), "observe");
    process.env.CODEX_CLIENT_GATE_MODE = "ENFORCE";
    assert.equal(codexGateMode(), "enforce");
    process.env.CODEX_CLIENT_GATE_MODE = "off";
    assert.equal(codexGateMode(), "off");
    process.env.CODEX_CLIENT_GATE_MODE = "garbage";
    assert.equal(codexGateMode(), "observe");
  } finally {
    if (saved === undefined) delete process.env.CODEX_CLIENT_GATE_MODE;
    else process.env.CODEX_CLIENT_GATE_MODE = saved;
  }
});

test("the log line carries the verdict and no secret", () => {
  const v = checkCodexOnlyGate({
    apiKeyInfo: CODEX_ONLY_KEY,
    headers: codexHeaders(),
    body: CODEX_BODY,
    mode: "observe",
  });
  const line = describeCodexGateObservation(v.observation!, CODEX_ONLY_KEY, "ws");
  assert.match(line, /transport=ws/);
  assert.match(line, /score=7\/7 ok=true wouldBlock=false/);
  assert.match(line, /originator="codex_exec"/);
  assert.match(line, /signals=ITOUS/);
  assert.doesNotMatch(line, /00000000-0000-4000-8000-000000000001/);
});
