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

import { isVisionModelId } from "../../src/shared/constants/visionModels.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import {
  getBestVisionModel,
  isCredentiallessProviderKey,
} from "../../src/lib/guardrails/visionBridgeRouter.ts";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.ts";

describe("vision bridge — credential-less providers are never a reroute target", () => {
  it("classifies the anonymous opencode gateways as credential-less", () => {
    // These are the two `anonymousFallback: true` gateways; `oc` is the `noAuth`
    // provider. All three used to be reachable as bridge targets.
    for (const key of ["opencode-zen", "opencode-go", "oc", "opencode"]) {
      assert.equal(isCredentiallessProviderKey(key), true, `${key} must be credential-less`);
    }
    // A real, credentialed provider must not be swept up by the same predicate.
    for (const key of ["cc", "claude", "gh", "github", "agy", "openai", "anthropic"]) {
      assert.equal(isCredentiallessProviderKey(key), false, `${key} must stay selectable`);
    }
  });

  it("never auto-selects a credential-less provider as the vision model", () => {
    const best = getBestVisionModel();
    if (!best) return; // no vision-capable candidate at all is a separate failure
    const prefix = best.includes("/") ? best.slice(0, best.indexOf("/")) : best;
    assert.equal(
      isCredentiallessProviderKey(prefix),
      false,
      `getBestVisionModel() picked ${best}, whose provider has no credential`
    );
  });

  it("excludes every credential-less namespace from the candidate pool", () => {
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
      const best = getBestVisionModel({ excludedModels: [] });
      assert.ok(
        !best || !best.startsWith(`${alias}/`),
        `${alias} must never be selected as a vision target`
      );
    }
  });
});

describe("vision bridge — the Claude 5 generation is vision-capable", () => {
  // claude-opus-5 is the one that regressed; the rest pin the family so the next
  // Claude 5 id added without a spec cannot silently resolve as blind.
  const CLAUDE_5 = [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
  ];

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
    for (const id of ["claude-instant-1", "gpt-5.4", "kimi-k2", "gemma-2-9b"]) {
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
