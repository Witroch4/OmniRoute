/**
 * chatCore streaming per-request cost recording (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: resolves the real per-request cost for a
 * completed streaming response and records it against the api key. onStreamComplete is synchronous,
 * so this is a sync fire-and-forget driven through calculateCost().then().catch() that never throws
 * to the caller. calculateCost and recordCost are injected so the hook stays decoupled. Behaviour
 * is byte-identical to the previous inline block. A resolver may return the detailed
 * `{ costUsd, priced }` result instead of a bare number; an unpriced one is reported through
 * `recordUnpricedCost` so a metered model with no price is not silently charged $0.
 */

import { isModelBudgetRedirect } from "../../services/responseModelEcho.ts";
import {
  applyFamilyMultiplier,
  getApiKeyFamilyMultiplier,
} from "@/lib/usage/modelFamilyMultiplier.ts";

/** The `{ costUsd, priced }` shape of `calculateCostDetailed` (lib/usage/costCalculator). */
type DetailedCost = { costUsd: number; priced: boolean; failed?: boolean };

type CostResolver = (
  provider: string,
  model: string,
  usage: Record<string, number | undefined> | null | undefined,
  options: { serviceTier?: string }
) => Promise<number | DetailedCost>;

/** Extra per-request ledger context threaded from the handler. */
type LedgerDetails = {
  serviceTier?: string | null;
  success?: boolean;
  timestamp?: string;
  requestId?: string | null;
};

/** Build a {@link LedgerDetails} for a completed streaming response. */
export function buildStreamLedgerDetails(
  serviceTier: string | null | undefined,
  success: boolean,
  requestId: string | null | undefined
): LedgerDetails {
  return { serviceTier, success, timestamp: new Date().toISOString(), requestId };
}

function toDetailedCost(resolved: number | DetailedCost): DetailedCost {
  return typeof resolved === "number" ? { costUsd: resolved, priced: true } : resolved;
}

export function recordStreamingCost(args: {
  apiKeyId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  streamUsage: Record<string, number | undefined> | null | undefined;
  serviceTier?: string;
  calculateCost: CostResolver;
  /**
   * `cost` is the REAL spend (served model's rates). `billedCost` is the client-facing
   * figure, passed only when a budget redirect or a family multiplier changes it (fork,
   * migrations 127/128); `details` is the per-request ledger breakdown (upstream).
   */
  recordCost: (
    apiKeyId: string,
    cost: number,
    billedCost?: number | null,
    details?: {
      provider?: string | null;
      model?: string | null;
      tokens?: unknown;
      serviceTier?: string | null;
      success?: boolean;
      timestamp?: string;
      requestId?: string | null;
    }
  ) => void;
  recordUnpricedCost?: (apiKeyId: string, cost: DetailedCost) => void;
  ledger?: LedgerDetails;
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
    .then(async (resolved) => {
      const cost = toDetailedCost(resolved);
      if (!cost.priced) args.recordUnpricedCost?.(apiKeyId, cost);
      const estimatedCost = cost.costUsd;
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
        ? toDetailedCost(
            await args.calculateCost(
              billedProviderForCost,
              args.billedModel as string,
              args.streamUsage,
              { serviceTier: args.serviceTier }
            )
          ).costUsd
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
      args.recordCost(apiKeyId, estimatedCost, billedCost, {
        provider: args.provider,
        model: args.model,
        tokens: args.streamUsage,
        serviceTier: args.serviceTier ?? args.ledger?.serviceTier,
        success: args.ledger?.success ?? true,
        timestamp: args.ledger?.timestamp,
        requestId: args.ledger?.requestId,
      });
    })
    .catch(() => {});
}
