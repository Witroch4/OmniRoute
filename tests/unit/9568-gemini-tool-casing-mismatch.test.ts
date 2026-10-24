import test from "node:test";
import assert from "node:assert/strict";

const { geminiToOpenAIResponse } =
  await import("../../open-sse/translator/response/gemini-to-openai.ts");
const { geminiToClaudeResponse } =
  await import("../../open-sse/translator/response/gemini-to-claude.ts");

function flatten(items) {
  return items.flatMap((item) => item || []);
}

// ── Gemini -> OpenAI tool name casing fix (#9568) ──────────────────────

test("gemini-to-openai: no toolNameMap — Gemini returns lowercase 'bash', translator outputs 'bash' (bug, unaffected by #10392 — that PR's static casing map applies only to the gemini-to-claude and openai-to-claude Claude Messages API paths, not this OpenAI-compatible passthrough path)", () => {
  const state = { toolCalls: new Map(), toolNameMap: null };
  const result = geminiToOpenAIResponse(
    {
      responseId: "resp-9568-1",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "bash", args: { code: "echo hi" } },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    state
  );

  const toolCall = result.find((c) => c.choices?.[0]?.delta?.tool_calls);
  const name = toolCall?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name;
  assert.equal(name, "bash", "Without toolNameMap, lowercase tool name should pass through as-is");
});

test("gemini-to-openai: toolNameMap has lowercase alias — Gemini returns 'bash', translator outputs 'Bash' (fix)", () => {
  const state = {
    toolCalls: new Map(),
    toolNameMap: new Map([["bash", "Bash"]]),
  };
  const result = geminiToOpenAIResponse(
    {
      responseId: "resp-9568-2",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "bash", args: { code: "echo hi" } },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    state
  );

  const toolCall = result.find((c) => c.choices?.[0]?.delta?.tool_calls);
  const name = toolCall?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name;
  assert.equal(
    name,
    "Bash",
    "With toolNameMap={{'bash','Bash'}}, lowercase tool name should be restored to TitleCase"
  );
});

// ── Gemini -> Claude tool name casing fix (#9568) ──────────────────────

// Fork: declaredToolCasing.ts step 3 returns the raw name, so without a toolNameMap
// the casing comes from the tools[] the client declared (Claude Code declares `Bash`).
test("gemini-to-claude: no toolNameMap — Gemini returns 'bash', translator outputs the declared 'Bash' (#10392 consolidated fix)", () => {
  const state = { clientTools: [{ name: "Bash", input_schema: { type: "object" } }] };
  const result = geminiToClaudeResponse(
    {
      responseId: "resp-9568-3",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "bash", args: { code: "echo hi" } },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    state
  );

  const toolUse = result.find((c) => c.type === "content_block_start");
  assert.equal(
    toolUse?.content_block?.name,
    "Bash",
    "Without toolNameMap, the client's declared casing restores the lowercase echo (gemini-to-claude, #10392)"
  );
});

test("gemini-to-claude: toolNameMap has lowercase alias — Gemini returns 'bash', translator outputs 'Bash' (fix)", () => {
  const state = {
    toolNameMap: new Map([["bash", "Bash"]]),
  };
  const result = geminiToClaudeResponse(
    {
      responseId: "resp-9568-4",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "bash", args: { code: "echo hi" } },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    state
  );

  const toolUse = result.find((c) => c.type === "content_block_start");
  assert.equal(
    toolUse?.content_block?.name,
    "Bash",
    "With toolNameMap={{'bash','Bash'}}, lowercase tool name should be restored to TitleCase without normalizeToolName reversing it"
  );
});
