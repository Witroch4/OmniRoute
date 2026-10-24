// Gemini/Antigravity echo function names in other casings (`read` for Claude Code's
// `Read`), and Claude Code rejects a tool_use whose name it never declared ("No such
// tool available"). Tool calls must come back in the spelling the CLIENT declared.
import test from "node:test";
import assert from "node:assert/strict";

import {
  findDeclaredToolName,
  restoreDeclaredToolName,
} from "../../open-sse/services/declaredToolCasing.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.ts";
import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";

const CLAUDE_CODE_TOOLS = ["Read", "Bash", "WebFetch", "WebSearch"].map((name) => ({
  name,
  input_schema: { type: "object", properties: {} },
}));

test("findDeclaredToolName prefers the exact spelling, then a case-insensitive match", () => {
  assert.equal(findDeclaredToolName(CLAUDE_CODE_TOOLS, "Read"), "Read");
  assert.equal(findDeclaredToolName(CLAUDE_CODE_TOOLS, "read"), "Read");
  assert.equal(findDeclaredToolName(CLAUDE_CODE_TOOLS, "WEBFETCH"), "WebFetch");
  assert.equal(findDeclaredToolName(CLAUDE_CODE_TOOLS, "Glob"), null);
  // OpenAI-shaped declarations count too.
  assert.equal(
    findDeclaredToolName([{ type: "function", function: { name: "get_weather" } }], "GET_WEATHER"),
    "get_weather"
  );
  assert.equal(findDeclaredToolName(null, "read"), null);
});

test("restoreDeclaredToolName: alias ledger first, then declared casing, then the raw name", () => {
  const ledger = new Map([["mcp_tool_x", "mcp__tool.x"]]);
  assert.equal(restoreDeclaredToolName("mcp_tool_x", ledger, CLAUDE_CODE_TOOLS), "mcp__tool.x");
  assert.equal(restoreDeclaredToolName("bash", ledger, CLAUDE_CODE_TOOLS), "Bash");
  assert.equal(restoreDeclaredToolName("server_probe", null, CLAUDE_CODE_TOOLS), "server_probe");
});

async function streamToolName(echoed: string, clientTools: unknown): Promise<string[]> {
  const ts = createSSETransformStreamWithLogger(
    FORMATS.ANTIGRAVITY,
    FORMATS.CLAUDE,
    "agy",
    null,
    null,
    "gemini-3.8-flash-high",
    "c1",
    null,
    null,
    null,
    null,
    false,
    false,
    clientTools
  );
  const chunk = {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ functionCall: { name: echoed, args: {} } }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    },
  };
  const reader = ts.readable.getReader();
  const collected = (async () => {
    let text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value);
    }
  })();
  const writer = ts.writable.getWriter();
  await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
  await writer.close();
  const text = await collected;
  return [...text.matchAll(/"type":"tool_use"[^}]*"name":"([^"]+)"/g)].map((m) => m[1]);
}

test("Antigravity -> Claude stream: a lowercased echo comes back as the declared name", async () => {
  assert.deepEqual(await streamToolName("read", CLAUDE_CODE_TOOLS), ["Read"]);
  assert.deepEqual(await streamToolName("Bash", CLAUDE_CODE_TOOLS), ["Bash"]);
  // Undeclared names are untouched (previous behaviour).
  assert.deepEqual(await streamToolName("web_search", CLAUDE_CODE_TOOLS), ["web_search"]);
  // Without the client's tools the name passes through as before.
  assert.deepEqual(await streamToolName("read", null), ["read"]);
});

test("non-streaming Gemini -> client: function calls take the declared casing", () => {
  const out = translateNonStreamingResponse(
    {
      candidates: [
        {
          content: { role: "model", parts: [{ functionCall: { name: "read", args: {} } }] },
          finishReason: "STOP",
        },
      ],
    },
    FORMATS.GEMINI,
    FORMATS.OPENAI,
    null,
    CLAUDE_CODE_TOOLS
  ) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> };
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "Read");
});
