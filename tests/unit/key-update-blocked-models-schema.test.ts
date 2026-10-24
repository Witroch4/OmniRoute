/**
 * PATCH /api/keys/:id reads `blockedModels`, and the dashboard sends it when a key is saved (Claude Code
 * family blocks, provider deny-lists), but the update schema did not declare the field: zod stripped it,
 * so a block was never stored and a blockedModels-only update answered 400 "No valid fields to update".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { updateKeyPermissionsSchema } = await import("../../src/shared/validation/schemas/keys.ts");

describe("updateKeyPermissionsSchema keeps blockedModels", () => {
  it("accepts an update that only sets blocked models", () => {
    const parsed = updateKeyPermissionsSchema.safeParse({ blockedModels: ["opencode-go/*"] });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.blockedModels, ["opencode-go/*"]);
  });

  it("keeps blocked models next to the other fields the dashboard sends", () => {
    const parsed = updateKeyPermissionsSchema.safeParse({
      name: "witalo",
      allowedModels: ["cc/*"],
      blockedModels: ["claude-opus*", "opus"],
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.blockedModels, ["claude-opus*", "opus"]);
  });

  it("an empty list clears the blocks", () => {
    const parsed = updateKeyPermissionsSchema.safeParse({ blockedModels: [] });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.blockedModels, []);
  });
});
