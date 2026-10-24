/**
 * Regression (#14003): the Vision Bridge must not whole-request reroute a BARE
 * model id whose vision capability is UNKNOWN.
 *
 * `kimi-for-coding` has no MODEL_SPECS entry (the Kimi Coding registry
 * deliberately sets no `supportsVision`), so
 * `getResolvedModelCapabilities("kimi-for-coding").supportsVision` resolves to
 * `null` (unknown) rather than `false` (proven text-only). For a bare id the
 * registry and models.dev sync lookups are skipped entirely, so `null` means
 * OmniRoute has no static knowledge of that wire id.
 *
 * Before this guard the request was rerouted to a different provider's model
 * (`command-code/moonshotai/Kimi-K2.6`) with no error surfaced to the client:
 * the wrong model answered, billing followed the wrong connection, and
 * `call_logs` recorded the substitute as if it were intended.
 *
 * Fixture note: #14117 later gave `kimi-for-coding` a MODEL_SPECS entry (Kimi K2.8
 * Preview, supportsVision: true), so it no longer exercises the UNKNOWN-capability
 * path. The cases below use `deepseek-coder-6.7b` (served by `llamagate`), which has
 * neither a spec nor a registry vision flag; a precondition test pins that so a future
 * spec change fails here loudly instead of silently turning these cases into no-ops.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { VisionBridgeGuardrail } = await import("../../../src/lib/guardrails/visionBridge.ts");
const { resetGuardrailsForTests } = await import("../../../src/lib/guardrails/registry.ts");
const { getResolvedModelCapabilities } = await import("../../../src/lib/modelCapabilities.ts");
import type { GuardrailContext } from "../../../src/lib/guardrails/base.ts";
import type { VisionModelConfig } from "../../../src/lib/guardrails/visionBridgeHelpers.ts";

let mockSettings: Record<string, unknown> = {};
let visionCallCount = 0;
let credentialsMock: (model: string) => Promise<boolean | null> = async () => null;
let logs: string[] = [];

function createGuardrail() {
  return new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => mockSettings,
      callVisionModel: async (_imageDataUri: string, _config: VisionModelConfig) => {
        visionCallCount++;
        return "described";
      },
      hasUsableCredentials: credentialsMock,
    },
  });
}

function createLogger(): GuardrailContext["log"] {
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push(`${level} ${args.map(String).join(" ")}`);
    };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  } as unknown as GuardrailContext["log"];
}

// Each case gets its own image URL: the shared describe cache is keyed on
// (imageUrl, prompt, model) and is module-level, so a repeated URL would let an
// earlier case's description satisfy a later case without calling the bridge.
function imagePayload(model: string, tag: string): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: `https://example.com/${tag}.png` } },
        ],
      },
    ],
  };
}

function baseSettings() {
  return {
    visionBridgeEnabled: true,
    visionBridgeModel: "auto/best-vision",
    visionBridgePrompt: "Describe this image concisely.",
    visionBridgeTimeout: 30000,
    visionBridgeMaxImages: 10,
  };
}

function warnLines(): string[] {
  return logs.filter((line) => line.startsWith("warn "));
}

test.beforeEach(() => {
  resetGuardrailsForTests({ registerDefaults: false });
  visionCallCount = 0;
  credentialsMock = async () => null;
  logs = [];
  mockSettings = baseSettings();
});

const BARE_UNKNOWN = "deepseek-coder-6.7b";
const QUALIFIED_UNKNOWN = `llamagate/${BARE_UNKNOWN}`;

test("VB-14003-FIXTURE: the bare and qualified fixture ids still have UNKNOWN vision", () => {
  assert.strictEqual(getResolvedModelCapabilities(BARE_UNKNOWN).supportsVision, null);
  const qualified = getResolvedModelCapabilities(QUALIFIED_UNKNOWN);
  assert.strictEqual(qualified.provider, "llamagate");
  assert.strictEqual(qualified.supportsVision, null);
});

test("VB-14003-BARE: keeps a bare model id with unknown vision capability instead of rerouting", async () => {
  // Models production exactly (reported with `kimi-for-coding`): hasUsableCredentialsForModel(bare)
  // is blind to the bare id (it splits on "/" and treats the MODEL name as a
  // provider, finds no rows, and reports false), while the Vision Bridge's
  // reroute target is a perfectly healthy, credentialed model. Before the fix
  // that combination rerouted the whole request to the substitute model.
  //
  // Fork: stricter than upstream — an unknown capability is not a blind verdict, so the
  // bridge steps aside entirely (no reroute AND no caption); the provider decides.
  credentialsMock = async (model: string) => (model === BARE_UNKNOWN ? false : null);

  const result = await createGuardrail().preCall(imagePayload(BARE_UNKNOWN, "bare-14003"), {
    model: BARE_UNKNOWN,
    log: createLogger(),
  });

  assert.strictEqual(result.block, false);
  assert.strictEqual(
    result.modifiedPayload,
    undefined,
    "the explicitly requested model must not be swapped for another provider's model"
  );
  assert.strictEqual(
    (result.meta as Record<string, unknown> | undefined)?.rerouted,
    undefined,
    "no reroute metadata may be emitted"
  );
  assert.strictEqual(visionCallCount, 0, "unknown capability: the request is sent as-is");
});

test("VB-14003-QUALIFIED: a provider-qualified id with unknown capability is sent as-is (fork)", async () => {
  // Upstream still reroutes a provider-qualified id with unknown capability. The fork does
  // not: `null` means the catalog has no opinion, and several such models read images fine
  // in production — the provider is the authority, so nothing is rewritten.
  credentialsMock = async () => null;

  for (const model of ["deepseek/deepseek-chat", QUALIFIED_UNKNOWN]) {
    const result = await createGuardrail().preCall(imagePayload(model, `qualified-${model}`), {
      model,
      log: createLogger(),
    });
    assert.strictEqual(result.block, false, model);
    assert.strictEqual(result.modifiedPayload, undefined, model);
    assert.strictEqual((result.meta as Record<string, unknown> | undefined)?.rerouted, undefined);
  }
  assert.strictEqual(visionCallCount, 0, "no caption for an unknown capability either");
  assert.ok(
    !warnLines().some((line) => line.includes("Whole-request vision reroute")),
    "an unknown capability must never be whole-request rerouted"
  );
});

test("VB-14003-ASSERTED: an asserted text-only provider-qualified id still reroutes", async () => {
  // The reroute itself stays intact for a model the catalog says cannot see.
  credentialsMock = async () => null;
  const model = "glm/glm-5.3";

  const result = await createGuardrail().preCall(imagePayload(model, "asserted-14003"), {
    model,
    log: createLogger(),
  });

  const body = result.modifiedPayload as Record<string, unknown>;
  assert.notStrictEqual(body.model, model);
  assert.strictEqual((result.meta as Record<string, unknown>).rerouted, true);
  assert.strictEqual(visionCallCount, 0, "describe path must not run when a reroute happened");
  assert.ok(
    warnLines().some((line) => line.includes("Whole-request vision reroute")),
    "a successful whole-request reroute must be logged with the original model"
  );
  assert.ok(
    warnLines().some((line) => line.includes(`Rerouted ${model} →`)),
    "the fork's VISION-BRIDGE Rerouted line is emitted too"
  );
});

test("VB-14003-BARE-SPEC: a bare id with a vision spec still skips the bridge entirely", async () => {
  // `kimi-k3` resolves supportsVision === true from MODEL_SPECS, so the
  // pass-through short-circuit must fire before any of the new logic runs.
  const result = await createGuardrail().preCall(imagePayload("kimi-k3", "bare-spec-14003"), {
    model: "kimi-k3",
    log: createLogger(),
  });

  assert.strictEqual(result.block, false);
  assert.strictEqual(result.modifiedPayload, undefined);
  assert.strictEqual(visionCallCount, 0);
  assert.strictEqual((result.meta as Record<string, unknown> | undefined)?.rerouted, undefined);
});

test("VB-14003-AUTO: the unknown-capability gate never fires for an auto/ model", async () => {
  // The auto-combo resolver does not filter candidates by vision capability, so
  // `auto/` must keep its reroute. Asserted here as "the new gate does not
  // suppress it" rather than by the resulting target model, because the vision
  // router's selection/negative caches are module-level and shared, which makes
  // the concrete substitute order-dependent. The end-to-end auto reroute is
  // already covered by tests/unit/guardrails/vision-bridge-auto-reroute.test.ts.
  credentialsMock = async () => null;

  const result = await createGuardrail().preCall(imagePayload("auto/best-vision", "auto-14003"), {
    model: "auto/best-vision",
    log: createLogger(),
  });

  assert.strictEqual(result.block, false);
  assert.ok(
    !warnLines().some((line) => line.includes("Vision capability unknown for bare model")),
    "the unknown-capability skip must never fire for an auto/ model"
  );
});
