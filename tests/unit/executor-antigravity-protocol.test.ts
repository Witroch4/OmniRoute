import { test } from "node:test";
import assert from "node:assert/strict";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

// Fork: user text sent to Antigravity goes through `obfuscateSensitiveWords`
// (open-sse/services/antigravityObfuscation.ts) — client/tool names such as "OmniRoute",
// "OpenCode" or "Cursor" get a zero-width joiner so they are not greppable upstream. Upstream
// dropped that step; the fork keeps it. Everything else in the prompt stays byte-for-byte.
const ZWJ = "‍";

// The default `cli` profile wraps the latest user turn like the official CLI
// (<USER_REQUEST>… + <ADDITIONAL_METADATA> clock); these tests are about the text inside it.
const unwrapCliUserTurn = (text: string | undefined): string =>
  (text ?? "").replace(
    /^<USER_REQUEST>\n([\s\S]*)\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>[\s\S]*<\/ADDITIONAL_METADATA>$/,
    "$1"
  );

test("AntigravityExecutor.transformRequest only obfuscates sensitive client names in prompt text", async () => {
  const executor = new AntigravityExecutor();
  const text = "OmniRoute, OpenCode, Cursor — keep this exact text 👩🏽‍💻";
  const body = {
    request: {
      contents: [{ role: "user", parts: [{ text }] }],
    },
  };

  const result = await executor.transformRequest("antigravity/gemini-3.8-flash-high", body, true, {
    projectId: "project-1",
  });

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  const transformedText = unwrapCliUserTurn(
    (result.request.contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[0].text
  );
  assert.ok(transformedText, "prompt text must survive");
  assert.notEqual(transformedText, text, "sensitive client names must be obfuscated");
  for (const word of ["OmniRoute", "OpenCode", "Cursor"]) {
    assert.equal(transformedText.includes(word), false, `${word} must not reach Google verbatim`);
  }
  // Removing only the inserted joiners gives the original text back, byte-for-byte; the
  // emoji's own ZWJ sequence is untouched.
  const restored = transformedText
    .replace(new RegExp(`O${ZWJ}mniRoute`, "g"), "OmniRoute")
    .replace(new RegExp(`O${ZWJ}penCode`, "g"), "OpenCode")
    .replace(new RegExp(`C${ZWJ}ursor`, "g"), "Cursor");
  assert.deepEqual(Buffer.from(restored), Buffer.from(text));
  assert.ok(transformedText.endsWith("keep this exact text 👩🏽‍💻"));
});

test("AntigravityExecutor.transformRequest leaves text without sensitive names byte-for-byte", async () => {
  const executor = new AntigravityExecutor();
  const text = "Plain prompt — keep this exact text 👩🏽‍💻";
  const result = await executor.transformRequest(
    "antigravity/gemini-3.8-flash-high",
    { request: { contents: [{ role: "user", parts: [{ text }] }] } },
    true,
    { projectId: "project-1" }
  );
  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  const transformedText = unwrapCliUserTurn(
    (result.request.contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[0].text
  );
  assert.deepEqual(Buffer.from(transformedText), Buffer.from(text));
});
