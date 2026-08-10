/**
 * chatCore streaming per-request cost recording (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: resolves the real per-request cost for a
 * completed streaming response and records it against the api key. onStreamComplete is synchronous,
 * so this is a sync fire-and-forget driven through calculateCost().then().catch() that never throws
 * to the caller. calculateCost and recordCost are injected so the hook stays decoupled. Behaviour
 * is byte-identical to the previous inline block.
 */

import { isModelBudgetRedirect } from "../../services/responseModelEcho.ts";
import {
  applyFamilyMultiplier,
  getApiKeyFamilyMultiplier,
} from "@/lib/usage/modelFamilyMultiplier.ts";

type CostResolver = (
  provider: string,
  model: string,
  usage: Record<string, number | undefined> | null | undefined,
  options: { serviceTier?: string }
) => Promise<number>;

export function recordStreamingCost(args: {
  apiKeyId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  streamUsage: Record<string, number | undefined> | null | undefined;
  serviceTier?: string;
  calculateCost: CostResolver;
  recordCost: (apiKeyId: string, cost: number, billedCost?: number | null) => void;
  /** Provider/model the CLIENT asked for, when a model budget rule redirected THIS
   * request (Finding 2 / migration 127) — same pair `headerResponseCost` uses in the
   * non-streaming path. */
  billedProvider?: string | null;
  billedModel?: string | null;
  /** Injected for tests; defaults to the real DB-backed resolver
   * (`src/lib/usage/modelFamilyMultiplier.ts`, migration 128) — the SAME shared
   * function `apiKeyUsageLimits.ts` and the analytics route use, keyed off the
   * BILLED pair (redirected or not) so all three paths can never disagree. */
  getFamilyMultiplier?: typeof getApiKeyFamilyMultiplier;
}): void {
  if (!args.apiKeyId || !args.streamUsage) return;

  const apiKeyId = args.apiKeyId;
  const isRedirect = isModelBudgetRedirect(args.billedModel);
  const getFamilyMultiplier = args.getFamilyMultiplier ?? getApiKeyFamilyMultiplier;
  args
    .calculateCost(args.provider, args.model, args.streamUsage, { serviceTier: args.serviceTier })
    .then(async (estimatedCost) => {
      if (estimatedCost <= 0) return;
      // The billed pair is the redirect target's ORIGIN when redirected, otherwise the
      // served pair itself — either way, this is what the client was actually charged
      // for, and what the family multiplier (migration 128) must key off. Both fields
      // gated on `isRedirect` together (mirrors chatCore.ts's billedProviderForCost/
      // billedModelForCost) — `billedProvider` and `billedModel` are captured in
      // lockstep by the real production caller today, but gating only one of them
      // would let a future/malformed caller that sets one without the other pick a
      // multiplier for a provider that was never actually billed (final-review Minor 3).
      const billedProviderForCost = isRedirect
        ? args.billedProvider || args.provider
        : args.provider;
      const billedModelForCost = isRedirect ? (args.billedModel as string) : args.model;
      const normalizedBaseCost = isRedirect
        ? await args.calculateCost(
            billedProviderForCost,
            args.billedModel as string,
            args.streamUsage,
            { serviceTier: args.serviceTier }
          )
        : estimatedCost;
      const multiplier = await getFamilyMultiplier(
        apiKeyId,
        billedProviderForCost,
        billedModelForCost
      );
      // Only pass a billedCost when it actually differs from the real cost (a redirect
      // happened, or a multiplier != 1 applies) — preserves the pre-existing "NULL means
      // normalized == real, no backfill" contract (migration 127) for the common case
      // where neither feature is configured on this key.
      const billedCost =
        isRedirect || multiplier !== 1
          ? applyFamilyMultiplier(normalizedBaseCost, multiplier)
          : undefined;
      args.recordCost(apiKeyId, estimatedCost, billedCost);
    })
    .catch(() => {});
}
