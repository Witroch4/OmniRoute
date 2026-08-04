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
}): void {
  if (!args.apiKeyId || !args.streamUsage) return;

  const apiKeyId = args.apiKeyId;
  const isRedirect = isModelBudgetRedirect(args.billedModel);
  args
    .calculateCost(args.provider, args.model, args.streamUsage, { serviceTier: args.serviceTier })
    .then(async (estimatedCost) => {
      if (estimatedCost <= 0) return;
      const billedCost = isRedirect
        ? await args.calculateCost(
            args.billedProvider || args.provider,
            args.billedModel as string,
            args.streamUsage,
            { serviceTier: args.serviceTier }
          )
        : undefined;
      args.recordCost(apiKeyId, estimatedCost, billedCost);
    })
    .catch(() => {});
}
