import test from "node:test";
import assert from "node:assert/strict";

import {
  AG_DECOY_TOOLS,
  AG_TOOL_SUFFIX,
  cloakAntigravityToolPayload,
  sanitizeAntigravityToolPayload,
  stripEnumDescriptions,
} from "../../open-sse/config/toolCloaking.ts";

type ToolDeclaration = {
  name: string;
  parameters?: Record<string, unknown>;
};

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  const record = value as Record<string, unknown>;
  return (
    Object.hasOwn(record, key) || Object.values(record).some((entry) => hasKeyDeep(entry, key))
  );
}

test("Antigravity tool sanitization preserves declared and historical tool names", () => {
  const payload = {
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "workspace_read",
              description: "Read a file",
              parameters: { type: "OBJECT", properties: {} },
            },
            {
              name: "run_command",
              description: "Run a command",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "workspace_read", args: { path: "/tmp/a" } } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "workspace_read", response: { ok: true } } }],
        },
      ],
    },
  };

  const result = sanitizeAntigravityToolPayload(payload);
  const declarations = result.request.tools[0].functionDeclarations;

  assert.deepEqual(
    declarations.map((tool: ToolDeclaration) => tool.name),
    ["workspace_read", "run_command"],
    "only client-declared tools should remain, in their original order"
  );
  assert.equal(
    result.request.contents[0].parts[0].functionCall.name,
    "workspace_read",
    "functionCall names must remain aligned with declarations"
  );
  assert.equal(
    result.request.contents[1].parts[0].functionResponse.name,
    "workspace_read",
    "functionResponse names must remain aligned with declarations"
  );
  assert.equal("_toolNameMap" in result, false, "sanitization must not create a reverse cloak map");
  assert.equal(
    "includeServerSideToolInvocations" in result.request,
    false,
    "sanitization must not opt into undeclared server-side tools"
  );
});

test("stripEnumDescriptions removes enumDescriptions at every nesting level", () => {
  const schema = {
    type: "OBJECT",
    enumDescriptions: ["should be removed at root"],
    properties: {
      mode: {
        type: "STRING",
        enum: ["a", "b"],
        enumDescriptions: ["desc a", "desc b"],
      },
      nested: {
        type: "OBJECT",
        properties: {
          choice: {
            type: "STRING",
            enumDescriptions: ["deep desc"],
          },
        },
      },
      list: {
        type: "ARRAY",
        items: {
          type: "STRING",
          enumDescriptions: ["item desc"],
        },
      },
    },
    anyOf: [{ type: "STRING", enumDescriptions: ["anyOf desc"] }],
    allOf: [{ oneOf: [{ type: "NUMBER", enumDescriptions: ["oneOf desc"] }] }],
    $defs: {
      shared: { type: "BOOLEAN", enumDescriptions: ["definition desc"] },
    },
    additionalProperties: {
      type: "STRING",
      enumDescriptions: ["additionalProperties desc"],
    },
  };

  const stripped = stripEnumDescriptions(schema) as Record<string, unknown>;

  assert.equal(hasKeyDeep(stripped, "enumDescriptions"), false);
  assert.deepEqual(
    ((stripped.properties as Record<string, unknown>).mode as Record<string, unknown>).enum,
    ["a", "b"]
  );
  assert.ok(Array.isArray(schema.properties.mode.enumDescriptions), "input must not be mutated");
});

test("Antigravity tool sanitization strips enumDescriptions without changing declarations", () => {
  const payload = {
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "workspace_read",
              description: "Read a file",
              parameters: {
                type: "OBJECT",
                enumDescriptions: ["root-level"],
                properties: {
                  mode: {
                    type: "STRING",
                    enum: ["read", "write"],
                    enumDescriptions: ["read mode", "write mode"],
                  },
                },
              },
            },
          ],
        },
      ],
      contents: [],
    },
  };

  const result = sanitizeAntigravityToolPayload(payload);
  const declaration = result.request.tools[0].functionDeclarations[0] as ToolDeclaration;
  const parameters = declaration.parameters as {
    enumDescriptions?: unknown;
    properties: { mode: { enumDescriptions?: unknown; enum: string[] } };
  };

  assert.equal(declaration.name, "workspace_read");
  assert.equal("enumDescriptions" in parameters, false);
  assert.equal("enumDescriptions" in parameters.properties.mode, false);
  assert.deepEqual(parameters.properties.mode.enum, ["read", "write"]);
});

// Fork: the executor still cloaks tool names (`_ide` suffix + decoys) before sanitizing —
// toolCloaking.ts keeps cloakAntigravityToolPayload, which upstream #8013 removed.

test("cloakAntigravityToolPayload cloaks custom tools, preserves native tools and injects decoys", () => {
  const payload = {
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "workspace_read",
              description: "Read a file",
              parameters: { type: "OBJECT", properties: {} },
            },
            {
              name: "run_command",
              description: "Native tool should stay visible",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "workspace_read", args: { path: "/tmp/a" } } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "workspace_read", response: { ok: true } } }],
        },
      ],
    },
  };

  const result = cloakAntigravityToolPayload(payload);
  const declarations = (result.body.request.tools?.[0] as any)?.functionDeclarations || [];
  const names = declarations.map((tool: { name: string }) => tool.name);

  assert.ok(names.includes(`workspace_read${AG_TOOL_SUFFIX}`));
  assert.ok(names.includes("run_command"));
  assert.ok(names.includes("browser_subagent"));
  assert.ok(names.includes("mcp_sequential_thinking_sequentialthinking"));
  for (const name of names) {
    assert.match(name, /^[a-zA-Z0-9_]+$/);
  }
  assert.equal(
    result.body.request.contents[0].parts[0].functionCall.name,
    `workspace_read${AG_TOOL_SUFFIX}`
  );
  assert.equal(
    result.body.request.contents[1].parts[0].functionResponse.name,
    `workspace_read${AG_TOOL_SUFFIX}`
  );
  assert.equal(result.toolNameMap?.get(`workspace_read${AG_TOOL_SUFFIX}`), "workspace_read");
  assert.equal(
    declarations.filter((tool: { name: string }) => tool.name === "browser_subagent").length,
    1
  );
  assert.ok(AG_DECOY_TOOLS.length > 20);
});

test("cloakAntigravityToolPayload composes namespace sanitization maps with Antigravity cloaking", () => {
  const payload = {
    _toolNameMap: new Map([["workspace_read", "mcp__filesystem__workspace_read"]]),
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "workspace_read",
              description: "Read a file",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
      contents: [],
    },
  };

  const result = cloakAntigravityToolPayload(payload);

  assert.equal(
    result.toolNameMap?.get(`workspace_read${AG_TOOL_SUFFIX}`),
    "mcp__filesystem__workspace_read"
  );
});

test("cloakAntigravityToolPayload strips enumDescriptions from declaration parameters", () => {
  const payload = {
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "workspace_read",
              description: "Read a file",
              parameters: {
                type: "OBJECT",
                enumDescriptions: ["root-level"],
                properties: {
                  mode: {
                    type: "STRING",
                    enum: ["read", "write"],
                    enumDescriptions: ["read mode", "write mode"],
                  },
                },
              },
            },
            {
              name: "run_command",
              description: "Native tool keeps visible name but loses enumDescriptions",
              parameters: {
                type: "OBJECT",
                properties: {
                  shell: {
                    type: "STRING",
                    enumDescriptions: ["bash", "zsh"],
                  },
                },
              },
            },
          ],
        },
      ],
      contents: [],
    },
  };

  const result = cloakAntigravityToolPayload(payload);
  const declarations = (result.body.request.tools?.[0] as any)?.functionDeclarations || [];

  const cloaked = declarations.find(
    (d: { name: string }) => d.name === `workspace_read${AG_TOOL_SUFFIX}`
  );
  assert.ok(cloaked, "cloaked client tool present");
  assert.equal("enumDescriptions" in cloaked.parameters, false);
  assert.equal("enumDescriptions" in cloaked.parameters.properties.mode, false);
  assert.deepEqual(cloaked.parameters.properties.mode.enum, ["read", "write"]);

  const native = declarations.find((d: { name: string }) => d.name === "run_command");
  assert.ok(native, "native tool preserved");
  assert.equal("enumDescriptions" in native.parameters.properties.shell, false);
});
