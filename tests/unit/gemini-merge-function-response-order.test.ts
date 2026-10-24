// Merging consecutive same-role Gemini turns must respect the CALLED model's rule
// for where functionResponse parts go: Claude (via Antigravity) wants tool results
// before text (upstream #17256), Gemini 4 wants them last (upstream #16642), and
// every other model keeps history order (the fork's original behaviour).
import test from "node:test";
import assert from "node:assert/strict";

import { mergeConsecutiveSameRoleContents } from "../../open-sse/translator/request/openai-to-gemini.ts";

const textThenResult = () => [
  { role: "model", parts: [{ functionCall: { name: "Read", args: {} } }] },
  { role: "user", parts: [{ text: "<system-reminder>" }] },
  { role: "user", parts: [{ functionResponse: { name: "Read", response: { result: "ok" } } }] },
];

const kinds = (parts: Array<Record<string, unknown>>) =>
  parts.map((p) => (p.functionResponse ? "functionResponse" : "text"));

test("Claude models get tool results before text in a merged user turn", () => {
  for (const model of ["claude-sonnet-5-5-high", "agy/claude-opus-5-5-medium"]) {
    const merged = mergeConsecutiveSameRoleContents(textThenResult(), model);
    assert.deepEqual(kinds(merged[1].parts), ["functionResponse", "text"], model);
  }
});

test("Gemini 4 gets tool results last in a merged user turn", () => {
  const merged = mergeConsecutiveSameRoleContents(
    [
      { role: "user", parts: [{ functionResponse: { name: "Read", response: {} } }] },
      { role: "user", parts: [{ text: "next" }] },
    ],
    "gemini-4-argon-high"
  );
  assert.deepEqual(kinds(merged[0].parts), ["text", "functionResponse"]);
});

test("other models keep history order (unchanged behaviour)", () => {
  for (const model of ["gemini-3.8-flash-high", "gemini-2.5-pro", ""]) {
    const merged = mergeConsecutiveSameRoleContents(textThenResult(), model);
    assert.deepEqual(kinds(merged[1].parts), ["text", "functionResponse"], model || "(none)");
  }
});

test("the merge never mutates the caller's contents", () => {
  const input = textThenResult();
  const snapshot = JSON.stringify(input);
  mergeConsecutiveSameRoleContents(input, "claude-sonnet-5-5-high");
  assert.equal(JSON.stringify(input), snapshot);
});
