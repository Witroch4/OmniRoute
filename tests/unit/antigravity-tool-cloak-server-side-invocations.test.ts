import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cloakAntigravityToolPayload,
  sanitizeAntigravityToolPayload,
} from "../../open-sse/config/toolCloaking.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

test("Antigravity payload does not synthesize decoys or server-side tool invocation flags", () => {
  const body = {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "list files in the repo" }],
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: "run a shell command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      },
    ],
  };
  const envelope = openaiToAntigravityRequest("gemini-pro-agent", body, false, {
    projectId: "test-project",
  });
  const sanitized = sanitizeAntigravityToolPayload(envelope as Record<string, unknown>);
  const request = sanitized.request as {
    tools?: Array<{ functionDeclarations?: Array<{ name: string }> }>;
    toolConfig?: Record<string, unknown>;
  };
  const declarationNames =
    request.tools?.flatMap((tool) => tool.functionDeclarations?.map((item) => item.name) ?? []) ??
    [];

  assert.deepEqual(declarationNames, ["bash"]);
  assert.equal(
    declarationNames.some((name) => name.endsWith("_ide")),
    false
  );
  assert.equal(declarationNames.includes("browser_subagent"), false);
  assert.equal(declarationNames.includes("mcp_sequential_thinking_sequentialthinking"), false);
  assert.equal(request.toolConfig?.includeServerSideToolInvocations, undefined);
  assert.equal(request.toolConfig?.include_server_side_tool_invocations, undefined);
});

// Fork: the executor still cloaks tool names (`_ide` suffix + decoys) before sanitizing —
// toolCloaking.ts keeps cloakAntigravityToolPayload, which upstream #8013 removed.

test("Antigravity payload sets include_server_side_tool_invocations when built-in-shaped decoy tools are injected (#6914)", () => {
  const body = {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "list files in the repo" }],
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: "run a shell command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      },
    ],
  };
  const envelope = openaiToAntigravityRequest("gemini-pro-agent", body, false, {
    projectId: "test-project",
  });
  const { body: cloaked } = cloakAntigravityToolPayload(envelope as Record<string, unknown>);
  const serialized = JSON.stringify(cloaked);
  const BUILTIN_SHAPED_DECOY_NAMES = [
    "search_web",
    "browser_subagent",
    "read_url_content",
    "generate_image",
  ];
  const injectedBuiltinShapedDecoys = BUILTIN_SHAPED_DECOY_NAMES.filter((name) =>
    serialized.includes(`"${name}"`)
  );
  const hasOptInFlag =
    serialized.includes("include_server_side_tool_invocations") ||
    serialized.includes("includeServerSideToolInvocations");

  assert.notDeepEqual(injectedBuiltinShapedDecoys, [], "expected decoy tools to be injected");
  assert.equal(
    hasOptInFlag,
    true,
    "expected the includeServerSideToolInvocations opt-in flag to be set alongside decoy tools"
  );
});

test("Antigravity payload does not set the opt-in flag when no decoys are injected", () => {
  const body = {
    model: "gemini-pro-agent",
    messages: [{ role: "user", content: "hello" }],
  };
  const envelope = openaiToAntigravityRequest("gemini-pro-agent", body, false, {
    projectId: "test-project",
  });
  const { body: cloaked } = cloakAntigravityToolPayload(envelope as Record<string, unknown>);
  const serialized = JSON.stringify(cloaked);
  const hasOptInFlag =
    serialized.includes("include_server_side_tool_invocations") ||
    serialized.includes("includeServerSideToolInvocations");
  assert.equal(hasOptInFlag, false, "flag should not be set when no tools/decoys are present");
});
