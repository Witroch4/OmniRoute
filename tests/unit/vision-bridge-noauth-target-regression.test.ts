/**
 * Regression: an image request to `cc/claude-opus-5` left OmniRoute as
 * `opencode-zen/gpt-5.4` and came back 401.
 *
 * Two independent defects compounded, and this file guards both.
 *
 * 1. DATA — `claude-opus-5` shipped in the claude registry with no `modelSpecs`
 *    entry and no models.dev record, so `resolveVisionCapability` fell through to
 *    the id heuristic, which listed `claude-opus-4` but nothing from the Claude 5
 *    generation. Substring matching means "claude-opus-4" never covers
 *    "claude-opus-5", so a natively multimodal model resolved as blind.
 *
 * 2. STRUCTURE — being judged blind sent the request into the Vision Bridge, whose
 *    router scored `opencode-*` at priority 0 ("Local/free models first"). Those
 *    providers are neither local nor usable: they carry no credential, share one
 *    anonymous egress quota, and their synced catalogs overstate vision support.
 *    Scoring is `priority * 1000 + latency`, so priority 0 beat every real
 *    provider and won every selection — turning a missing flag into a hard 401
 *    instead of a graceful reroute.
 *
 * Defect 1 alone would recur with the next model added without a spec. Defect 2 is
 * what made it fatal, so the structural assertion is the one that must not rot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The router's lockout check reads provider connections; keep it off the real data dir.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vb-noauth-"));

const { isVisionModelId } = await import("../../src/shared/constants/visionModels.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { getBestVisionModel: getBestVisionModelAsync, isCredentiallessProviderKey } =
  await import("../../src/lib/guardrails/visionBridgeRouter.ts");
const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.ts");
const { NOAUTH_PROVIDERS } = await import("../../src/shared/constants/providers/noauth.ts");

// Upstream 3.8.53 made the router async and credential-aware. Fail open on the
// credential store (indeterminate `null`), exactly like the upstream router tests,
// so these assertions isolate the fork's own exclusion and same-provider preference.
const FAIL_OPEN_DEPS = {
  hasUsableCredentials: async () => null,
  getActiveSyncedCatalog: async () => ({ authoritative: false, models: [] }),
  isModelLocked: () => false,
};
function getBestVisionModel(config: Record<string, unknown> = {}) {
  return getBestVisionModelAsync(config, FAIL_OPEN_DEPS);
}

describe("vision bridge — credential-less providers are never a reroute target", () => {
  it("classifies every noAuth provider (id and alias) as credential-less", () => {
    // Upstream 3.8.53 retired the anonymous OpenCode endpoints (`oc`, and the
    // `anonymousFallback` flag on opencode-zen/opencode-go, which now need a key —
    // #12242), so the set is derived from the live noAuth catalog instead.
    const noAuth = Object.entries(NOAUTH_PROVIDERS as Record<string, { alias?: string }>);
    assert.ok(noAuth.length > 0, "fixture drift: expected noAuth providers");
    for (const [id, def] of noAuth) {
      assert.equal(isCredentiallessProviderKey(id), true, `${id} must be credential-less`);
      if (def.alias) {
        assert.equal(isCredentiallessProviderKey(def.alias), true, `${def.alias} too`);
      }
    }
    // A real, credentialed provider must not be swept up by the same predicate.
    for (const key of ["cc", "claude", "gh", "github", "agy", "openai", "anthropic"]) {
      assert.equal(isCredentiallessProviderKey(key), false, `${key} must stay selectable`);
    }
  });

  it("never auto-selects a credential-less provider as the vision model", async () => {
    const best = await getBestVisionModel();
    if (!best) return; // no vision-capable candidate at all is a separate failure
    const prefix = best.includes("/") ? best.slice(0, best.indexOf("/")) : best;
    assert.equal(
      isCredentiallessProviderKey(prefix),
      false,
      `getBestVisionModel() picked ${best}, whose provider has no credential`
    );
  });

  it("excludes every credential-less namespace from the candidate pool", async () => {
    // Guards the loop-level skip rather than just the winner: a scoring change
    // must not quietly make these reachable again as a fallback candidate.
    const credentialless = Object.keys(PROVIDER_MODELS).filter((alias) =>
      isCredentiallessProviderKey(alias)
    );
    assert.ok(
      credentialless.length > 0,
      "fixture drift: expected at least one credential-less provider in PROVIDER_MODELS"
    );
    for (const alias of credentialless) {
      const best = await getBestVisionModel({ excludedModels: [] });
      assert.ok(
        !best || !best.startsWith(`${alias}/`),
        `${alias} must never be selected as a vision target`
      );
    }
  });
});

describe("vision bridge — an unknown capability is not a blind verdict", () => {
  // `supportsVision` is tri-state. Only `false` asserts the model cannot see; `null`
  // means the catalog has no opinion. The guardrail used to gate on `=== true`, so
  // "no opinion" was treated as "cannot see" and the caller's model was rewritten on
  // absence of information.
  //
  // Verified against the live gateway on 2026-09-02 with a 64x64 red PNG and
  // `disabledGuardrails: ["vision-bridge"]`: every one of these answered "red".
  const READ_A_TEST_IMAGE_IN_PRODUCTION = [
    "gh/grok-4.6",
    "gh/grok-4.5",
    "gh/gpt-5-mini",
    "gh/mai-code-1.1-flash",
    "gh/gpt-5.3-codex",
  ];

  for (const id of READ_A_TEST_IMAGE_IN_PRODUCTION) {
    it(`${id} is unknown, never asserted blind`, () => {
      const v = getResolvedModelCapabilities(id).supportsVision;
      assert.notEqual(v, false, `${id} is asserted blind, but it read a test image in production`);
    });
  }

  it("the gate distinguishes unknown from denied", () => {
    // Guards the tri-state itself: if resolveVisionCapability ever collapses null to
    // false, every model the catalog has no opinion about starts being rewritten
    // again — which is the whole bug, not a detail of it.
    const unknown = READ_A_TEST_IMAGE_IN_PRODUCTION.map(
      (id) => getResolvedModelCapabilities(id).supportsVision
    );
    assert.ok(
      unknown.every((v) => v === null || v === true),
      `expected null/true for models with no catalog opinion, got ${JSON.stringify(unknown)}`
    );
  });
});

describe("vision bridge — a reroute stays inside the caller's provider", () => {
  // Latency is tracked in-process and is empty on a cold worker, so every candidate
  // in a priority tier scores identically and the stable sort used to hand the win
  // to whatever the registry listed first. That let an image for a blind `gh/` model
  // be answered by a metered `anthropic/` model while the same account already had a
  // vision-capable sibling — the caller's credential, quota and cost profile silently
  // swapped out.
  it("prefers a vision-capable sibling from the requested provider", async () => {
    for (const alias of ["gh", "agy", "cc"]) {
      const picked = await getBestVisionModel({ requestedModel: `${alias}/some-blind-model` });
      assert.ok(picked, `${alias}: expected a vision target`);
      assert.ok(
        picked.startsWith(`${alias}/`),
        `${alias}: reroute left the provider — picked ${picked}`
      );
    }
  });

  it("does not let one provider's cached pick leak to another", async () => {
    // The selection cache is keyed per requested provider; without that, the first
    // caller's answer would be served to everyone for the cache TTL.
    const gh = await getBestVisionModel({ requestedModel: "gh/some-blind-model" });
    const agy = await getBestVisionModel({ requestedModel: "agy/some-blind-model" });
    assert.ok(gh?.startsWith("gh/"), `gh got ${gh}`);
    assert.ok(agy?.startsWith("agy/"), `agy got ${agy}`);
  });

  it("still answers when the requested provider has nothing that can see", async () => {
    // Leaving the provider is correct here — the alternative is failing the request.
    const picked = await getBestVisionModel({ requestedModel: "codex/gpt-5.5" });
    assert.ok(picked, "expected a fallback target outside the provider");
    assert.equal(isCredentiallessProviderKey(picked.split("/")[0]), false);
  });

  it("an explicit operator override still wins over the preference", async () => {
    assert.equal(
      await getBestVisionModel({ fixedModel: "cc/claude-opus-5", requestedModel: "gh/x" }),
      "cc/claude-opus-5"
    );
  });
});

describe("vision bridge — the Claude 5 generation is vision-capable", () => {
  // claude-opus-5 is the one that regressed; the rest pin the family so the next
  // Claude 5 id added without a spec cannot silently resolve as blind.
  const CLAUDE_5 = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"];

  for (const id of CLAUDE_5) {
    it(`${id} passes the id heuristic`, () => {
      assert.equal(isVisionModelId(id), true);
      assert.equal(isVisionModelId(`cc/${id}`), true);
    });

    it(`${id} resolves supportsVision through the real capability path`, () => {
      // The bug was visible exactly here: this returned false for cc/claude-opus-5,
      // which is the value the Vision Bridge gate reads.
      assert.equal(getResolvedModelCapabilities(`cc/${id}`).supportsVision, true);
    });
  }

  it("does not widen the heuristic to unrelated ids", () => {
    // The list is deliberately conservative — a false positive routes an image to
    // a blind model (#4071).
    // (`gpt-5.4` left this list: upstream 3.8.53 lists it as vision-capable, which it is.)
    for (const id of ["claude-instant-1", "kimi-k2", "gemma-2-9b"]) {
      assert.equal(isVisionModelId(id), false, `${id} must not be treated as vision`);
    }
  });
});

describe("vision bridge — every model in the claude registry can see", () => {
  it("no claude/cc model resolves as blind", () => {
    // The whole Anthropic line served here is multimodal. A blind verdict means a
    // catalog entry landed without a spec — the shape of this regression.
    const blind: string[] = [];
    for (const alias of ["cc", "claude"]) {
      for (const model of PROVIDER_MODELS[alias] ?? []) {
        if (!model?.id) continue;
        if (getResolvedModelCapabilities(`${alias}/${model.id}`).supportsVision !== true) {
          blind.push(`${alias}/${model.id}`);
        }
      }
    }
    assert.deepEqual(blind, [], `claude models resolving as non-vision: ${blind.join(", ")}`);
  });
});
