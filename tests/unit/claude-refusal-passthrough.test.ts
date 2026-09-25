import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A safeguards refusal from Anthropic is a 200 whose stop_reason is "refusal" and
// whose category rides in stop_details (e.g. { category: "bio" }), often with no
// content block at all. It is a decision about the conversation, not a provider
// failure. Claude Code handles it on its own: it shows the safeguards notice and
// retries once on a fallback model. The proxy used to see "empty content", rewrite
// it into a synthetic 502, retry 3x with a 5s account cooldown, and the client
// never saw the refusal - one flagged session produced 533 upstream calls.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-refusal-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const core = await import("../../src/lib/db/core.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { isEmptyContentResponse } = await import("../../open-sse/services/errorClassifier.ts");

const enc = new TextEncoder();

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const STOP_DETAILS = { type: "refusal", category: "bio", explanation: "flagged" };

function sse(type: string, data: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const MESSAGE_START = sse("message_start", {
  message: {
    id: "msg_refusal",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0 },
  },
});

async function readStream(chunks: string[], onFailure?: (p: unknown) => void) {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  const options = {
    mode: "passthrough",
    sourceFormat: FORMATS.CLAUDE,
    provider: "claude",
    model: "claude-opus-5-5",
    body: { messages: [{ role: "user", content: "hello" }] },
    onFailure,
  } as unknown as Parameters<typeof createSSEStream>[0];
  return new Response(source.pipeThrough(createSSEStream(options))).text();
}

test("non-stream: empty content + stop_reason=refusal is NOT an empty-content failure", () => {
  assert.equal(
    isEmptyContentResponse({
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: "refusal",
      stop_details: STOP_DETAILS,
    }),
    false
  );
});

test("non-stream: empty content + end_turn is still a failure (guard kept)", () => {
  assert.equal(isEmptyContentResponse({ content: [], stop_reason: "end_turn" }), true);
});

test("stream: refusal with no content block passes through with stop_details, no error", async () => {
  let failure: unknown = null;
  const text = await readStream(
    [
      MESSAGE_START,
      sse("message_delta", {
        delta: { stop_reason: "refusal", stop_sequence: null, stop_details: STOP_DETAILS },
        usage: { output_tokens: 0 },
      }),
      sse("message_stop", {}),
    ],
    (p) => {
      failure = p;
    }
  );
  assert.equal(failure, null, "a refusal must not be reported as a provider failure");
  assert.doesNotMatch(text, /event: error/);
  assert.match(text, /"stop_reason":"refusal"/);
  assert.match(text, /"category":"bio"/, "the category must reach the client untouched");
  assert.match(text, /event: message_stop/);
});

test("stream: empty stream WITHOUT refusal still errors (guard kept)", async () => {
  await assert.rejects(
    readStream([
      MESSAGE_START,
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }),
      sse("message_stop", {}),
    ]),
    /empty response/i
  );
});
