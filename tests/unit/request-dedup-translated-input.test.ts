import assert from "node:assert/strict";
import { test } from "node:test";
import { computeRequestHash, deduplicate } from "../../open-sse/services/requestDedup.ts";

test("distinct Responses inputs must execute independently while in flight", async () => {
  const bodies = ["item-918", "item-919"].map((text) => ({
    model: "codex/model",
    temperature: 0,
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
  }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const pending = bodies.map((body, index) => deduplicate(computeRequestHash(body), async () => {
    calls++;
    await gate;
    return index;
  }));
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 2);
  assert.deepEqual(results.map((result) => result.result), [0, 1]);
});

test("all translated content and output constraints participate in the identity", () => {
  const base = { model: "model", temperature: 0, messages: [{ role: "user", content: "same" }] };
  for (const field of ["input", "instructions", "system", "contents", "generationConfig", "output_config", "text", "thinking", "previous_response_id"]) {
    assert.notEqual(computeRequestHash({ ...base, [field]: "first" }), computeRequestHash({ ...base, [field]: "second" }), field);
  }
});

test("identical requests still share one upstream execution", async () => {
  const hash = computeRequestHash({ model: "identical", temperature: 0, input: "same" });
  let calls = 0;
  const execute = async () => { calls++; await Promise.resolve(); return "result"; };
  const results = await Promise.all([deduplicate(hash, execute), deduplicate(hash, execute)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.result), ["result", "result"]);
});
