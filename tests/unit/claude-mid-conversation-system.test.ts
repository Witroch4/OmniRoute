// Claude Code (2.1.29x) sends context as role:"system" turns in the MIDDLE of
// messages[] (beta mid-conversation-system): the "# Environment" block after the
// first user turn and a "<total_tokens>" reminder after each tool result. The
// claude-to-openai hub used to map every non-user role to "assistant", so on
// Gemini/Antigravity those turns became MODEL text — the model "had said" its own
// environment, and the history ended on a model turn.
import test from "node:test";
import assert from "node:assert/strict";

import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

function claudeCodeShapedBody() {
  return {
    model: "gemini-3.8-flash-high",
    max_tokens: 4096,
    stream: true,
    system: [{ type: "text", text: "You are Claude Code." }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Read notes.txt" }] },
      { role: "system", content: [{ type: "text", text: "# Environment\ncwd: /work" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/work/notes.txt" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }],
      },
      { role: "system", content: "<total_tokens>1000 tokens left</total_tokens>" },
    ],
  };
}

test("claude -> openai: mid-conversation system turns become user turns, never assistant", () => {
  const out = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "gpt-x",
    claudeCodeShapedBody(),
    true
  ) as { messages: Array<{ role: string; content: unknown }> };

  assert.equal(out.messages[0].role, "system");
  const text = (m: { content: unknown }) =>
    typeof m.content === "string" ? m.content : (JSON.stringify(m.content ?? "") ?? "");
  const envTurn = out.messages.find((m) => text(m).includes("# Environment"));
  assert.equal(envTurn?.role, "user");
  const reminder = out.messages.find((m) => text(m).includes("<total_tokens>"));
  assert.equal(reminder?.role, "user");
  for (const m of out.messages.slice(1)) {
    assert.notEqual(m.role, "system", "only the leading message may stay system");
  }
  assert.ok(
    !out.messages.some((m) => m.role === "assistant" && text(m).includes("# Environment")),
    "context must never be attributed to the assistant"
  );
});

test("claude -> antigravity: Claude Code context lands in user turns and the history ends on user", () => {
  const out = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.ANTIGRAVITY,
    "gemini-3.8-flash-high",
    claudeCodeShapedBody(),
    true,
    { accessToken: "x", projectId: "proj-1" },
    "agy"
  ) as { request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> } };

  const contents = out.request.contents;
  const modelText = contents
    .filter((c) => c.role === "model")
    .flatMap((c) => c.parts)
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n");
  assert.ok(!modelText.includes("# Environment"));
  assert.ok(!modelText.includes("<total_tokens>"));
  assert.equal(contents.at(-1)?.role, "user");
  // The tool result keeps its place right after the call.
  const callIndex = contents.findIndex((c) => c.parts.some((p) => p.functionCall));
  assert.ok(contents[callIndex + 1].parts.some((p) => p.functionResponse));
});
