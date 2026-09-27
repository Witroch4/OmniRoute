import test from "node:test";
import assert from "node:assert/strict";

const { DocumentInputSupportGuardrail, findDocumentInputRule, payloadHasDocumentInput } =
  await import("../../../src/lib/guardrails/documentInputSupport.ts");
const { guardrailRegistry, resetGuardrailsForTests } =
  await import("../../../src/lib/guardrails/registry.ts");

const PDF = "data:application/pdf;base64,JVBERi0xLjcKJcfsj6IK";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

const openAiPdf = (model: string) => ({
  model,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Transcreva." },
        { type: "file", file: { filename: "p.pdf", file_data: PDF } },
      ],
    },
  ],
});

const guardrail = new DocumentInputSupportGuardrail();

test("Copilot + Claude + PDF is rejected before any upstream call", async () => {
  // 2026-09-27: 7 such calls cost ~996k input tokens each and exhausted the
  // monthly Copilot quota — the base64 was billed as text.
  for (const model of ["gh/claude-sonnet-5", "github/claude-opus-4.8"]) {
    const result = await guardrail.preCall(openAiPdf(model), { model });
    assert.equal(result.block, true, model);
    assert.match(String(result.message), /base64 text/);
    assert.match(String(result.message), /image_url/);
  }
});

test("Antigravity + Claude + PDF is rejected (upstream 404/500 arms a lockout)", async () => {
  for (const model of [
    "agy/claude-sonnet-5",
    "antigravity/claude-sonnet-5",
    "agy/claude-opus-4-6-thinking",
    "no-think/agy/claude-sonnet-4-6",
  ]) {
    const result = await guardrail.preCall(openAiPdf(model), { model });
    assert.equal(result.block, true, model);
  }
});

test("routes outside the rules are untouched (gemini on agy and gpt on codex measured reading the PDF)", async () => {
  for (const model of [
    "agy/gemini-3.7-flash-high",
    "cx/gpt-6-luna",
    "gh/gpt-5.6-luna",
    "cc/claude-sonnet-5",
  ]) {
    const result = await guardrail.preCall(openAiPdf(model), { model });
    assert.equal(result.block, false, model);
  }
});

test("images keep working on the covered routes", async () => {
  const model = "agy/claude-sonnet-5";
  const imageUrl = {
    model,
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: PNG } }] }],
  };
  const imageAsFile = {
    model,
    messages: [{ role: "user", content: [{ type: "file", file: { file_data: PNG } }] }],
  };
  assert.equal((await guardrail.preCall(imageUrl, { model })).block, false);
  assert.equal((await guardrail.preCall(imageAsFile, { model })).block, false);
});

test("text attachments are left for OM to flatten, not rejected", async () => {
  const model = "gh/claude-sonnet-5";
  const body = {
    model,
    messages: [
      { role: "user", content: [{ type: "file", file: { name: "notes.txt", content: "hello" } }] },
    ],
  };
  assert.equal((await guardrail.preCall(body, { model })).block, false);
});

test("Anthropic document blocks and Responses input_file are detected too", () => {
  assert.equal(
    payloadHasDocumentInput({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
            },
          ],
        },
      ],
    }),
    true
  );
  assert.equal(
    payloadHasDocumentInput({
      input: [{ role: "user", content: [{ type: "input_file", file_data: PDF }] }],
    }),
    true
  );
});

test("a rule needs a provider prefix: bare ids and combos are never blocked", () => {
  assert.equal(findDocumentInputRule("claude-sonnet-5"), null);
  assert.equal(findDocumentInputRule(""), null);
  assert.equal(findDocumentInputRule(undefined), null);
});

test("the default registry blocks the request with the guardrail's message", async () => {
  resetGuardrailsForTests();
  const result = await guardrailRegistry.runPreCallHooks(openAiPdf("gh/claude-sonnet-5"), {
    model: "gh/claude-sonnet-5",
  });
  assert.equal(result.blocked, true);
  assert.equal(result.guardrail, "document-input-support");

  const disabled = await guardrailRegistry.runPreCallHooks(openAiPdf("gh/claude-sonnet-5"), {
    model: "gh/claude-sonnet-5",
    disabledGuardrails: ["document-input-support"],
  });
  assert.equal(disabled.blocked, false);
});
